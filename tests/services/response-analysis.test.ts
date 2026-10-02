import { randomInt, randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import { logger } from "@/config/logger"
import { database } from "@/db/client"
import { generateStructured, hasLlmBudget } from "@/services/llm"
import { findLatestResponseSummary, summarizeDay, summarizePreviousDayIfMissing } from "@/services/response-analysis"
import { deletePingsByPayload, deleteResponseSummariesByDays } from "../support/database"

vi.mock("@/services/llm", () => ({ generateStructured: vi.fn(), hasLlmBudget: vi.fn() }))

const MILLISECONDS_PER_MINUTE = 60 * 1000

const MILLISECONDS_PER_DAY = 24 * 60 * MILLISECONDS_PER_MINUTE

const WRITTEN_SUMMARY = {
  summary: "Of 8 pings, 3 failed, 2 of them between 03:00 and 04:00 UTC.",
  findings: ["Failures clustered at 03:00 UTC", "The caller IP changed once"],
}

const FIRST_ORIGIN = "203.0.113.7"

const SECOND_ORIGIN = "198.51.100.4"

const SEEDED_PINGS = [
  { minute: 10, statusCode: 200, durationMs: 100, error: null, responseKind: "clean_echo", origin: FIRST_ORIGIN },
  { minute: 20, statusCode: 200, durationMs: 200, error: null, responseKind: "clean_echo", origin: FIRST_ORIGIN },
  {
    minute: 3 * 60 + 5,
    statusCode: null,
    durationMs: 30_000,
    error: "Request to httpbin failed: fetch failed",
    responseKind: "failed",
    origin: null,
  },
  {
    minute: 3 * 60 + 10,
    statusCode: 502,
    durationMs: 150,
    error: "httpbin answered with status 502",
    responseKind: "gateway_error",
    origin: null,
  },
  {
    minute: 3 * 60 + 15,
    statusCode: 200,
    durationMs: 300,
    error: null,
    responseKind: "clean_echo",
    origin: SECOND_ORIGIN,
  },
  {
    minute: 14 * 60,
    statusCode: 404,
    durationMs: 50,
    error: "httpbin answered with status 404",
    responseKind: "client_error",
    origin: SECOND_ORIGIN,
  },
  {
    minute: 14 * 60 + 5,
    statusCode: 200,
    durationMs: 400,
    error: null,
    responseKind: "echo_mismatch",
    origin: FIRST_ORIGIN,
  },
  { minute: 23 * 60 + 59, statusCode: 200, durationMs: 500, error: null, responseKind: "empty", origin: null },
  {
    minute: -1,
    statusCode: null,
    durationMs: 9000,
    error: "Seeded before the day",
    responseKind: "failed",
    origin: null,
  },
  {
    minute: 24 * 60,
    statusCode: null,
    durationMs: 9000,
    error: "Seeded after the day",
    responseKind: "failed",
    origin: null,
  },
]

const WHOLE_DAY_STATISTICS = {
  totalPings: 8,
  failedPings: 3,
  responseKinds: { clean_echo: 3, failed: 1, gateway_error: 1, client_error: 1, echo_mismatch: 1, empty: 1 },
  statusCodes: { "200": 5, "404": 1, "502": 1, none: 1 },
  failuresByUtcHour: { "03:00": 2, "14:00": 1 },
  latencyMs: { p50: 300, p95: 500, max: 500 },
  origins: [FIRST_ORIGIN, SECOND_ORIGIN],
  originCount: 2,
  longestFailureStreak: 2,
}

const seededDay = new Date(Date.UTC(2230, 0, 4) + randomInt(0, 3500) * MILLISECONDS_PER_DAY)

const runMarker = { seeded: true, suite: "tests/services/response-analysis", runId: randomUUID() }

const dayOf = (offset: number) => new Date(seededDay.getTime() + offset * MILLISECONDS_PER_DAY)

const minuteOf = (minute: number) => new Date(seededDay.getTime() + minute * MILLISECONDS_PER_MINUTE)

const touchedDays = Array.from({ length: 9 }, (_value, offset) => dayOf(offset - 4))

const SEEDED_DAY_TEXT = seededDay.toISOString().slice(0, 10)

const fakeNow = (now: Date) => vi.useFakeTimers({ toFake: ["Date"], now })

const answerWithSummary = () =>
  vi.mocked(generateStructured).mockResolvedValue({
    output: WRITTEN_SUMMARY,
    usage: { inputTokens: 412, cachedInputTokens: 256, outputTokens: 120 },
  })

const readModelRequest = () => vi.mocked(generateStructured).mock.calls[0][0]

const findStoredSummary = (day: Date) => database.responseSummary.findUnique({ where: { day } })

const seedSummary = (offset: number, status: string) =>
  database.responseSummary.create({
    data: {
      day: dayOf(offset),
      status,
      summary: status === "written" ? "Seeded summary" : null,
      statistics: { totalPings: 0 },
      inputTokens: status === "written" ? 300 : 0,
    },
  })

beforeAll(async () => {
  await database.ping.createMany({
    data: SEEDED_PINGS.map(({ minute, ...fields }) => ({
      ...fields,
      createdAt: minuteOf(minute),
      payload: { ...runMarker, minute },
    })),
  })
})

beforeEach(() => {
  fakeNow(new Date(dayOf(1).getTime() + 3 * MILLISECONDS_PER_MINUTE))
  vi.mocked(hasLlmBudget).mockResolvedValue(true)
  answerWithSummary()
})

afterEach(async () => {
  vi.useRealTimers()
  await deleteResponseSummariesByDays(touchedDays)
})

afterAll(async () => {
  await deletePingsByPayload("runId", [runMarker.runId])
})

describe("summarizeDay: the statistics", () => {
  test("works out the day's numbers from its pings and saves them with the written summary and its tokens, cached ones included", async () => {
    const summary = await summarizeDay(seededDay)

    expect(summary).toMatchObject({
      day: seededDay,
      status: "written",
      summary: WRITTEN_SUMMARY.summary,
      findings: WRITTEN_SUMMARY.findings,
      statistics: WHOLE_DAY_STATISTICS,
      inputTokens: 412,
      cachedInputTokens: 256,
      outputTokens: 120,
    })
    expect(await findStoredSummary(seededDay)).toStrictEqual(summary)
    expect(generateStructured).toHaveBeenCalledOnce()
    expect(readModelRequest().promptCacheKey).toBe("ping-monitor-summary")
  })

  test("gives the model the day's numbers, one line each, and no ping rows", async () => {
    await summarizeDay(seededDay)
    const { prompt, instructions } = readModelRequest()

    expect(prompt.split("\n")).toStrictEqual([
      `Day: ${SEEDED_DAY_TEXT} (UTC)`,
      "Covers: 00:00 to 24:00 UTC, the whole day",
      "Pings: 8",
      "Failed pings: 3",
      "Response kinds: clean_echo × 3, failed × 1, gateway_error × 1, client_error × 1, echo_mismatch × 1, empty × 1",
      "HTTP status codes: 200 × 5, 404 × 1, 502 × 1, none × 1",
      "Failed pings by UTC hour: 03:00 × 2, 14:00 × 1",
      "Latency of successful pings: p50 300 ms, p95 500 ms, max 500 ms",
      `Caller IPs seen by httpbin, 2 in all, in order of first appearance: ${FIRST_ORIGIN}, ${SECOND_ORIGIN}`,
      "Longest run of consecutive failed pings: 2",
    ])
    expect(instructions).toContain("Use only the numbers in the prompt.")
    expect(instructions).toContain('say "no failures"')
  })

  test("describes a day with no pings plainly", async () => {
    const summary = await summarizeDay(dayOf(2))
    const { prompt } = readModelRequest()

    expect(summary.statistics).toStrictEqual({
      totalPings: 0,
      failedPings: 0,
      responseKinds: {},
      statusCodes: {},
      failuresByUtcHour: {},
      latencyMs: null,
      origins: [],
      originCount: 0,
      longestFailureStreak: 0,
    })
    expect(prompt.split("\n").slice(2)).toStrictEqual([
      "Pings: 0",
      "Failed pings: 0",
      "Response kinds: none",
      "HTTP status codes: none",
      "Failed pings by UTC hour: none",
      "Latency of successful pings: none, no ping succeeded",
      "Caller IPs seen by httpbin, 0 in all, in order of first appearance: none",
      "Longest run of consecutive failed pings: 0",
    ])
  })

  test("asks for a summary and at most 4 findings", async () => {
    await summarizeDay(seededDay)
    const { schema } = readModelRequest()

    expect(schema.safeParse(WRITTEN_SUMMARY).success).toBe(true)
    expect(schema.safeParse({ summary: "Quiet day.", findings: [] }).success).toBe(true)
    expect(schema.safeParse({ ...WRITTEN_SUMMARY, findings: ["1", "2", "3", "4", "5"] }).success).toBe(false)
    expect(schema.safeParse({ findings: [] }).success).toBe(false)
  })
})

describe("summarizeDay: saving", () => {
  test("saves the row as pending, with its statistics, before the model is asked", async () => {
    vi.mocked(generateStructured).mockImplementation(async () => {
      expect(await findStoredSummary(seededDay)).toMatchObject({ status: "pending", statistics: WHOLE_DAY_STATISTICS })
      return { output: WRITTEN_SUMMARY, usage: { inputTokens: 412, cachedInputTokens: 256, outputTokens: 120 } }
    })

    expect(await summarizeDay(seededDay)).toMatchObject({ status: "written" })
  })

  test("replaces an earlier summary of the same day", async () => {
    const first = await summarizeDay(seededDay)
    vi.mocked(hasLlmBudget).mockResolvedValue(false)

    const second = await summarizeDay(seededDay)

    expect(second).toMatchObject({
      id: first.id,
      status: "skipped_budget",
      summary: null,
      findings: null,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    })
  })

  test("saves skipped_budget, without calling the model, when the hour's budget is spent", async () => {
    vi.mocked(hasLlmBudget).mockResolvedValue(false)

    const summary = await summarizeDay(seededDay)

    expect(summary).toMatchObject({ status: "skipped_budget", summary: null, statistics: WHOLE_DAY_STATISTICS })
    expect(await findStoredSummary(seededDay)).toStrictEqual(summary)
    expect(generateStructured).not.toHaveBeenCalled()
  })

  test.each(["llm budget spent", "prompt too long"])(
    "saves skipped_budget when the model layer refuses with %s",
    async (refusal) => {
      vi.mocked(generateStructured).mockRejectedValue(new Error(refusal))
      const errorLog = vi.spyOn(logger, "error")

      expect(await summarizeDay(seededDay)).toMatchObject({ status: "skipped_budget", inputTokens: 0 })
      expect(errorLog).not.toHaveBeenCalled()
    },
  )

  test("saves failed, and logs the error, when the model call throws", async () => {
    const modelFailure = new Error("The model call timed out")
    vi.mocked(generateStructured).mockRejectedValue(modelFailure)
    const errorLog = vi.spyOn(logger, "error")

    const summary = await summarizeDay(seededDay)

    expect(summary).toMatchObject({ status: "failed", summary: null, findings: null, inputTokens: 0 })
    expect(await findStoredSummary(seededDay)).toStrictEqual(summary)
    expect(errorLog).toHaveBeenCalledExactlyOnceWith(
      { err: modelFailure, responseSummaryId: summary.id, day: SEEDED_DAY_TEXT },
      expect.any(String),
    )
  })

  test("saves failed when checking the budget throws", async () => {
    vi.mocked(hasLlmBudget).mockRejectedValue(new Error("database is down"))

    expect(await summarizeDay(seededDay)).toMatchObject({ status: "failed" })
    expect(generateStructured).not.toHaveBeenCalled()
  })
})

describe("summarizePreviousDayIfMissing", () => {
  test("summarizes the whole of yesterday, UTC, when it has no summary yet", async () => {
    const summary = await summarizePreviousDayIfMissing()

    expect(summary).toMatchObject({ day: seededDay, status: "written", statistics: WHOLE_DAY_STATISTICS })
  })

  test.each(["written", "skipped_budget", "failed"])(
    "does nothing when yesterday already has a %s summary",
    async (status) => {
      const existing = await seedSummary(0, status)

      expect(await summarizePreviousDayIfMissing()).toBeNull()
      expect(await findStoredSummary(seededDay)).toStrictEqual(existing)
      expect(generateStructured).not.toHaveBeenCalled()
      expect(hasLlmBudget).not.toHaveBeenCalled()
    },
  )

  test("tries again when yesterday's summary was left pending", async () => {
    await seedSummary(0, "pending")

    expect(await summarizePreviousDayIfMissing()).toMatchObject({ day: seededDay, status: "written" })
  })
})

describe("findLatestResponseSummary", () => {
  test.each([
    { offset: -1, relativeDay: "yesterday" },
    { offset: -3, relativeDay: "earlier" },
  ])("marks a summary from $offset days back as $relativeDay", async ({ offset, relativeDay }) => {
    fakeNow(minuteOf(9 * 60))
    const seeded = await seedSummary(offset, "written")

    expect(await findLatestResponseSummary()).toStrictEqual({ ...seeded, relativeDay })
  })
})
