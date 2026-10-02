import "server-only"
import * as zod from "zod"
import { logger } from "@/config/logger"
import type { Prisma, ResponseSummary } from "@/db/generated/client"
import type { LatestResponseSummary, RelativeDay } from "@/lib/response-summary"
import { listPingOutcomesBetween } from "@/models/ping"
import {
  findNewestResponseSummary,
  findResponseSummaryByDay,
  saveResponseSummary,
  updateResponseSummary,
} from "@/models/response-summary"
import { generateStructured, hasLlmBudget } from "@/services/llm"

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

const ORIGIN_LIMIT = 10

const FINISHED_STATUSES = ["written", "skipped_budget", "failed"]

const BUDGET_REFUSALS = ["llm budget spent", "prompt too long"]

const RELATIVE_DAYS: Partial<Record<number, RelativeDay>> = { 1: "yesterday" }

const SUMMARY_PROMPT_CACHE_KEY = "ping-monitor-summary"

const SUMMARY_INSTRUCTIONS = [
  "You write a short daily summary for an uptime monitor that regularly POSTs a small random JSON payload to httpbin.org/anything and checks the reply.",
  "The monitor tags every reply in code. clean_echo: httpbin echoed the payload back exactly. echo_mismatch: a 2xx reply whose echo differed from the payload. empty: a 2xx reply with no JSON body. client_error: a 4xx reply. gateway_error: a 5xx reply. failed: no reply arrived, from a timeout or a network error.",
  "A failed ping is one with a client_error, gateway_error or failed reply. Caller IPs are the monitor's own public address as httpbin saw it, so a change means the monitor's network changed.",
  "Use only the numbers in the prompt. Don't guess at causes the numbers can't show.",
  'Write the summary in 2 to 4 sentences of plain words. Mention the counts, and when failures clustered, with times in UTC. When there were no failures, say "no failures" plainly.',
  "Add up to 4 findings, each one short sentence of plain text without markdown, on patterns worth knowing, like a cluster of failures, slow latency or a new caller IP. Leave the list empty when there is nothing to add.",
].join(" ")

type PingOutcome = Awaited<ReturnType<typeof listPingOutcomesBetween>>[number]

type PingStatistics = ReturnType<typeof describePings>

type Counts = Record<string, number>

type FailureStreak = { current: number; longest: number }

type GeneratedSummary = {
  output: zod.infer<typeof summarySchema>
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number }
}

export const summarizeDay = async (day: Date) => {
  const statistics = describePings(await listPingOutcomesBetween(day, nextUtcDay(day)))
  const pendingSummary = await saveResponseSummary(day, { status: "pending", statistics })
  return writeSummary(pendingSummary, statistics).catch((error: unknown) => saveUnwrittenSummary(pendingSummary, error))
}

const describePings = (outcomes: PingOutcome[]) => {
  const failures = outcomes.filter(isFailure)
  const origins = listOrigins(outcomes)
  return {
    totalPings: outcomes.length,
    failedPings: failures.length,
    responseKinds: countBy(outcomes, readResponseKind),
    statusCodes: countBy(outcomes, describeStatusCode),
    failuresByUtcHour: countBy(failures, describeUtcHour),
    latencyMs: describeLatency(outcomes.filter(isSuccess).map(readDuration)),
    origins: origins.slice(0, ORIGIN_LIMIT),
    originCount: origins.length,
    longestFailureStreak: outcomes.reduce(extendFailureStreak, { current: 0, longest: 0 }).longest,
  }
}

const isFailure = (outcome: PingOutcome) => outcome.error !== null

const isSuccess = (outcome: PingOutcome) => outcome.error === null

const readResponseKind = (outcome: PingOutcome) => outcome.responseKind

const readDuration = (outcome: PingOutcome) => outcome.durationMs

const describeStatusCode = (outcome: PingOutcome) => outcome.statusCode?.toString() ?? "none"

const describeUtcHour = (outcome: PingOutcome) => `${formatUtcTime(outcome.createdAt).slice(0, 2)}:00`

const countBy = (outcomes: PingOutcome[], describe: (outcome: PingOutcome) => string) =>
  outcomes.map(describe).reduce(addOne, {})

const addOne = (counts: Counts, key: string): Counts => ({ ...counts, [key]: (counts[key] ?? 0) + 1 })

const describeLatency = (durations: number[]) => {
  if (durations.length === 0) return null
  const sortedDurations = durations.toSorted((first, second) => first - second)
  return {
    p50: pickPercentile(sortedDurations, 50),
    p95: pickPercentile(sortedDurations, 95),
    max: sortedDurations[sortedDurations.length - 1],
  }
}

const pickPercentile = (sortedDurations: number[], percentile: number) =>
  sortedDurations[Math.ceil((percentile / 100) * sortedDurations.length) - 1]

const listOrigins = (outcomes: PingOutcome[]) => [...new Set(outcomes.flatMap(readOrigin))]

const readOrigin = (outcome: PingOutcome) => (outcome.origin === null ? [] : [outcome.origin])

const extendFailureStreak = (streak: FailureStreak, outcome: PingOutcome): FailureStreak => {
  const current = isFailure(outcome) ? streak.current + 1 : 0
  return { current, longest: Math.max(streak.longest, current) }
}

const writeSummary = async (pendingSummary: ResponseSummary, statistics: PingStatistics) => {
  if (!(await hasLlmBudget())) return updateResponseSummary(pendingSummary.id, { status: "skipped_budget" })
  const prompt = buildSummaryPrompt(pendingSummary, statistics)
  const generatedSummary = await generateStructured({
    schema: summarySchema,
    instructions: SUMMARY_INSTRUCTIONS,
    prompt,
    promptCacheKey: SUMMARY_PROMPT_CACHE_KEY,
  })
  return updateResponseSummary(pendingSummary.id, toWrittenSummary(generatedSummary))
}

const toWrittenSummary = ({ output, usage }: GeneratedSummary): Prisma.ResponseSummaryUpdateInput => ({
  status: "written",
  summary: output.summary,
  findings: output.findings,
  inputTokens: usage.inputTokens,
  cachedInputTokens: usage.cachedInputTokens,
  outputTokens: usage.outputTokens,
})

const saveUnwrittenSummary = (pendingSummary: ResponseSummary, error: unknown) => {
  if (isBudgetRefusal(error)) return updateResponseSummary(pendingSummary.id, { status: "skipped_budget" })
  logger.error(
    { err: error, responseSummaryId: pendingSummary.id, day: formatDay(pendingSummary.day) },
    "Response summary was saved but could not be written",
  )
  return updateResponseSummary(pendingSummary.id, { status: "failed" })
}

const isBudgetRefusal = (error: unknown) => error instanceof Error && BUDGET_REFUSALS.includes(error.message)

const buildSummaryPrompt = ({ day }: ResponseSummary, statistics: PingStatistics) =>
  [
    `Day: ${formatDay(day)} (UTC)`,
    "Covers: 00:00 to 24:00 UTC, the whole day",
    `Pings: ${statistics.totalPings}`,
    `Failed pings: ${statistics.failedPings}`,
    `Response kinds: ${describeCounts(statistics.responseKinds)}`,
    `HTTP status codes: ${describeCounts(statistics.statusCodes)}`,
    `Failed pings by UTC hour: ${describeCounts(statistics.failuresByUtcHour)}`,
    `Latency of successful pings: ${describeLatencyLine(statistics.latencyMs)}`,
    `Caller IPs seen by httpbin, ${statistics.originCount} in all, in order of first appearance: ${describeList(statistics.origins)}`,
    `Longest run of consecutive failed pings: ${statistics.longestFailureStreak}`,
  ].join("\n")

const describeCounts = (counts: Counts) =>
  describeList(Object.entries(counts).map(([key, count]) => `${key} × ${count}`))

const describeLatencyLine = (latency: PingStatistics["latencyMs"]) =>
  latency === null ? "none, no ping succeeded" : `p50 ${latency.p50} ms, p95 ${latency.p95} ms, max ${latency.max} ms`

const describeList = (entries: string[]) => (entries.length === 0 ? "none" : entries.join(", "))

const formatDay = (day: Date) => day.toISOString().slice(0, 10)

const formatUtcTime = (moment: Date) => moment.toISOString().slice(11, 16)

export const summarizePreviousDayIfMissing = async () => {
  const yesterday = new Date(startOfUtcDay(new Date()).getTime() - MILLISECONDS_PER_DAY)
  if (isFinished(await findResponseSummaryByDay(yesterday))) return null
  return summarizeDay(yesterday)
}

const isFinished = (summary: ResponseSummary | null) => summary !== null && FINISHED_STATUSES.includes(summary.status)

export const findLatestResponseSummary = async (): Promise<LatestResponseSummary | null> => {
  const summary = await findNewestResponseSummary()
  return summary && { ...summary, relativeDay: describeRelativeDay(summary.day, new Date()) }
}

const describeRelativeDay = (day: Date, now: Date) =>
  RELATIVE_DAYS[(startOfUtcDay(now).getTime() - day.getTime()) / MILLISECONDS_PER_DAY] ?? "earlier"

const startOfUtcDay = (moment: Date) =>
  new Date(Date.UTC(moment.getUTCFullYear(), moment.getUTCMonth(), moment.getUTCDate()))

const nextUtcDay = (day: Date) => new Date(day.getTime() + MILLISECONDS_PER_DAY)

const summarySchema = zod.object({
  summary: zod.string().describe("2 to 4 sentences in plain words, with counts and UTC times"),
  findings: zod.array(zod.string()).max(4).describe("Up to 4 findings, one short sentence each"),
})
