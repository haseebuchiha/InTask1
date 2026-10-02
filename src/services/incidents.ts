import "server-only"
import * as zod from "zod"
import { logger } from "@/config/logger"
import type { Incident, Ping, Prisma } from "@/db/generated/client"
import { createIncident, listIncidents, updateIncidentReport } from "@/models/incident"
import { averageSuccessfulDurationBetween, listRecentDurations } from "@/models/ping"
import { broadcastIncident } from "@/services/live-updates"
import { generateStructured, hasLlmBudget } from "@/services/llm"

export { findIncidentById } from "@/models/incident"

const HTTPBIN_URL = "https://httpbin.org/anything"

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

const MINIMUM_BASELINE_PINGS = 12

const SLOW_MULTIPLE = 2

const CRITICAL_MULTIPLE = 5

const RECENT_PING_COUNT = 12

const JSON_CHARACTER_LIMIT = 2000

const RECENT_INCIDENT_LIMIT = 50

const REPORT_PROMPT_CACHE_KEY = "ping-monitor-incident"

const REPORT_INSTRUCTIONS = [
  "You explain incidents for an uptime monitor that regularly POSTs a small random JSON payload to httpbin.org/anything and times the reply.",
  "The monitor has already decided that this ping is an incident and set its severity from the numbers. Don't question either. Your only job is to explain it.",
  "Write a one-sentence summary of what happened, 2 to 4 likely causes, and 2 to 4 recommendations that the person running the monitor could act on.",
  "Use only the facts in the prompt. httpbin echoes the payload back, so the payload is rarely the cause. Say so when the data can't tell the causes apart.",
  "Keep every cause and recommendation to one short sentence of plain text, without markdown.",
].join(" ")

type DurationBaseline = Awaited<ReturnType<typeof averageSuccessfulDurationBetween>>

type SteadyBaseline = DurationBaseline & { averageDurationMs: number }

type GeneratedReport = {
  output: zod.infer<typeof reportSchema>
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number }
}

type RecentPing = Pick<Ping, "durationMs" | "error">

export const reportIncidentForPing = async (ping: Ping) => {
  const baseline = await averageSuccessfulDurationBetween(dayBefore(ping.createdAt), ping.createdAt)
  if (!isSlowComparedTo(baseline, ping)) return null
  const incident = await createIncident(buildIncidentFields(ping, baseline.averageDurationMs))
  const reportedIncident = await writeReport(incident, ping)
  broadcastSavedIncident(reportedIncident)
  return reportedIncident
}

const dayBefore = (moment: Date) => new Date(moment.getTime() - MILLISECONDS_PER_DAY)

const isSlowComparedTo = (baseline: DurationBaseline, ping: Ping): baseline is SteadyBaseline =>
  hasSteadyBaseline(baseline) && (ping.error !== null || ping.durationMs >= SLOW_MULTIPLE * baseline.averageDurationMs)

const hasSteadyBaseline = (baseline: DurationBaseline): baseline is SteadyBaseline =>
  baseline.averageDurationMs !== null && baseline.count >= MINIMUM_BASELINE_PINGS

const buildIncidentFields = (ping: Ping, averageDurationMs: number): Prisma.IncidentCreateInput => ({
  ping: { connect: { id: ping.id } },
  severity: decideSeverity(ping, averageDurationMs),
  durationMs: ping.durationMs,
  averageDurationMs: Math.round(averageDurationMs),
  reportStatus: "pending",
})

const decideSeverity = (ping: Ping, averageDurationMs: number) =>
  ping.error !== null || ping.durationMs >= CRITICAL_MULTIPLE * averageDurationMs ? "critical" : "warning"

const writeReport = (incident: Incident, ping: Ping) =>
  requestReport(incident, ping).catch((error: unknown) => saveFailedReport(incident, error))

const requestReport = async (incident: Incident, ping: Ping) => {
  if (!(await hasLlmBudget())) return updateIncidentReport(incident.id, { reportStatus: "skipped_budget" })
  const prompt = await buildReportPrompt(incident, ping)
  const generatedReport = await generateStructured({
    schema: reportSchema,
    instructions: REPORT_INSTRUCTIONS,
    prompt,
    promptCacheKey: REPORT_PROMPT_CACHE_KEY,
  })
  return updateIncidentReport(incident.id, toWrittenReport(generatedReport))
}

const toWrittenReport = ({ output, usage }: GeneratedReport): Prisma.IncidentUpdateInput => ({
  reportStatus: "written",
  summary: output.summary,
  likelyCauses: output.likelyCauses,
  recommendations: output.recommendations,
  inputTokens: usage.inputTokens,
  cachedInputTokens: usage.cachedInputTokens,
  outputTokens: usage.outputTokens,
})

const saveFailedReport = (incident: Incident, error: unknown) => {
  logger.error(
    { err: error, incidentId: incident.id, pingId: incident.pingId },
    "Incident was saved but its report could not be written",
  )
  return updateIncidentReport(incident.id, { reportStatus: "failed" })
}

const broadcastSavedIncident = (incident: Incident) => {
  try {
    broadcastIncident(incident)
  } catch (error) {
    logger.error({ err: error, incidentId: incident.id }, "Incident was saved but could not be broadcast")
  }
}

export const listRecentIncidents = () => listIncidents(RECENT_INCIDENT_LIMIT)

const buildReportPrompt = async (incident: Incident, ping: Ping) => {
  const recentPings = await listRecentDurations(RECENT_PING_COUNT)
  return [...describeSlowPing(ping), ...describeBaseline(incident, recentPings), ...describeExchange(ping)].join("\n")
}

const describeSlowPing = (ping: Ping) => [
  `Endpoint: POST ${HTTPBIN_URL}`,
  `Ping time: ${ping.createdAt.toISOString()}`,
  `Duration: ${ping.durationMs} ms`,
  `Status code: ${ping.statusCode ?? "none, no reply arrived"}`,
  `Error: ${ping.error ?? "none"}`,
]

const describeBaseline = (incident: Incident, recentPings: RecentPing[]) => [
  `Severity, set by the monitor: ${incident.severity}`,
  `Average duration of successful pings in the 24 hours before this one: ${incident.averageDurationMs} ms`,
  `This ping took ${describeMultiple(incident)} times that average`,
  `Durations of the ${recentPings.length} most recent pings, newest first: ${recentPings.map(describeRecentPing).join(", ")}`,
]

const describeMultiple = (incident: Incident) => (incident.durationMs / incident.averageDurationMs).toFixed(1)

const describeRecentPing = (recentPing: RecentPing) =>
  `${recentPing.durationMs} ms${recentPing.error === null ? "" : " (failed)"}`

const describeExchange = (ping: Ping) => [
  `Payload sent, as JSON cut to ${JSON_CHARACTER_LIMIT} characters: ${cutJson(ping.payload)}`,
  `Response received, as JSON cut to ${JSON_CHARACTER_LIMIT} characters: ${cutJson(ping.response)}`,
]

const cutJson = (value: Prisma.JsonValue) => JSON.stringify(value).slice(0, JSON_CHARACTER_LIMIT)

const reportSchema = zod.object({
  summary: zod.string().describe("One sentence on what happened"),
  likelyCauses: zod.array(zod.string()).min(2).max(4).describe("2 to 4 likely causes, one short sentence each"),
  recommendations: zod.array(zod.string()).min(2).max(4).describe("2 to 4 recommendations, one short sentence each"),
})
