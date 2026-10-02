import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { logger } from "@/config/logger"
import type { ResponseSummary } from "@/db/generated/client"
import { startResponseSummaryTimer, stopResponseSummaryTimerOnShutdown } from "@/jobs/response-summary"
import { summarizePreviousDayIfMissing } from "@/services/response-analysis"

vi.mock("@/services/response-analysis", () => ({ summarizePreviousDayIfMissing: vi.fn() }))

const CHECK_INTERVAL_MS = 5 * 60 * 1000

const buildSummary = (overrides: Partial<ResponseSummary> = {}): ResponseSummary => ({
  id: 4,
  createdAt: new Date("2026-10-02T00:05:00.000Z"),
  updatedAt: new Date("2026-10-02T00:05:04.000Z"),
  day: new Date("2026-10-01T00:00:00.000Z"),
  status: "written",
  summary: "All 288 pings succeeded, so there were no failures.",
  findings: ["Latency stayed under 1 second"],
  statistics: { totalPings: 288 },
  inputTokens: 412,
  cachedInputTokens: 256,
  outputTokens: 120,
  ...overrides,
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  vi.mocked(summarizePreviousDayIfMissing).mockResolvedValue(null)
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe("response summary timer", () => {
  test("checks for a missing summary of yesterday every 5 minutes, and not at start", async () => {
    startResponseSummaryTimer()

    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - 1)
    expect(summarizePreviousDayIfMissing).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(summarizePreviousDayIfMissing).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2)
    expect(summarizePreviousDayIfMissing).toHaveBeenCalledTimes(3)
  })

  test("starting it again replaces the running timer instead of adding a second one", async () => {
    startResponseSummaryTimer()
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS / 2)
    startResponseSummaryTimer()

    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS / 2)
    expect(summarizePreviousDayIfMissing).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS / 2)
    expect(summarizePreviousDayIfMissing).toHaveBeenCalledOnce()
  })
})

describe("response summary job logging", () => {
  test("logs a written summary with its day and tokens, cached ones included", async () => {
    vi.mocked(summarizePreviousDayIfMissing).mockResolvedValue(buildSummary())
    const infoLog = vi.spyOn(logger, "info")
    startResponseSummaryTimer()

    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)

    expect(infoLog).toHaveBeenLastCalledWith(
      {
        responseSummaryId: 4,
        day: "2026-10-01",
        status: "written",
        inputTokens: 412,
        cachedInputTokens: 256,
        outputTokens: 120,
      },
      "Response summary written",
    )
  })

  test.each(["skipped_budget", "failed"])("logs a warning for a %s summary", async (status) => {
    vi.mocked(summarizePreviousDayIfMissing).mockResolvedValue(
      buildSummary({ status, summary: null, findings: null, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }),
    )
    const warnLog = vi.spyOn(logger, "warn")
    startResponseSummaryTimer()

    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)

    expect(warnLog).toHaveBeenCalledExactlyOnceWith(
      { responseSummaryId: 4, day: "2026-10-01", status, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      "Response summary not written",
    )
  })

  test("logs nothing when yesterday already has its summary", async () => {
    const infoLog = vi.spyOn(logger, "info")
    const warnLog = vi.spyOn(logger, "warn")
    const errorLog = vi.spyOn(logger, "error")
    startResponseSummaryTimer()
    infoLog.mockClear()

    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)

    expect(summarizePreviousDayIfMissing).toHaveBeenCalledOnce()
    expect(infoLog).not.toHaveBeenCalled()
    expect(warnLog).not.toHaveBeenCalled()
    expect(errorLog).not.toHaveBeenCalled()
  })

  test("logs an error when the check throws, and keeps the timer running", async () => {
    vi.mocked(summarizePreviousDayIfMissing).mockRejectedValueOnce(new Error("database is down"))
    const errorLog = vi.spyOn(logger, "error")
    startResponseSummaryTimer()

    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(errorLog).toHaveBeenCalledExactlyOnceWith(
      { err: new Error("database is down") },
      "Response summary job failed, trying again at the next check",
    )

    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(summarizePreviousDayIfMissing).toHaveBeenCalledTimes(2)
    expect(errorLog).toHaveBeenCalledOnce()
  })
})

describe("shutdown", () => {
  test("on SIGTERM or SIGINT, stops the timer", async () => {
    const signalListeners = vi.spyOn(process, "once").mockReturnValue(process)
    startResponseSummaryTimer()
    stopResponseSummaryTimerOnShutdown()

    const [[firstSignal, stopOnSigterm], [secondSignal, stopOnSigint]] = signalListeners.mock.calls
    expect([firstSignal, secondSignal]).toStrictEqual(["SIGTERM", "SIGINT"])
    expect(stopOnSigint).toBe(stopOnSigterm)

    stopOnSigterm("SIGTERM")
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3)

    expect(summarizePreviousDayIfMissing).not.toHaveBeenCalled()
  })
})
