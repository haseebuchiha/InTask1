import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { GET as openStreamRoute } from "@/app/api/pings/stream/route"
import { PING_INTERVAL_MS } from "@/config/env"
import { logger } from "@/config/logger"
import type { Incident, Ping } from "@/db/generated/client"
import { startPingTimer, stopPingTimerAndStreamsOnShutdown } from "@/jobs/ping"
import { reportIncidentForPing } from "@/services/incidents"
import { recordPing } from "@/services/ping"
import { buildStreamRequest, closeTestStreams, openTestStream } from "../support/event-stream"

vi.mock("@/services/ping", () => ({ recordPing: vi.fn() }))
vi.mock("@/services/incidents", () => ({ reportIncidentForPing: vi.fn() }))

const buildPing = (overrides: Partial<Ping> = {}): Ping => ({
  id: 7,
  createdAt: new Date("2026-09-30T12:00:00.000Z"),
  payload: { requestId: "job-test" },
  statusCode: 200,
  durationMs: 187,
  response: { json: { requestId: "job-test" } },
  error: null,
  responseKind: "clean_echo",
  origin: null,
  ...overrides,
})

const buildIncident = (overrides: Partial<Incident> = {}): Incident => ({
  id: 3,
  createdAt: new Date("2026-09-30T12:00:01.000Z"),
  pingId: 7,
  severity: "warning",
  durationMs: 420,
  averageDurationMs: 180,
  reportStatus: "written",
  summary: "The ping took more than twice as long as usual.",
  likelyCauses: ["httpbin was slow", "The network was congested"],
  recommendations: ["Watch the next pings", "Check httpbin's status"],
  inputTokens: 812,
  cachedInputTokens: 0,
  outputTokens: 96,
  ...overrides,
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  vi.mocked(reportIncidentForPing).mockResolvedValue(null)
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  closeTestStreams()
})

describe("ping timer", () => {
  test("runs the ping job once every PING_INTERVAL_MS", async () => {
    startPingTimer()

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS - 1)
    expect(recordPing).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(recordPing).toHaveBeenCalledTimes(1)
  })

  test("starting it again replaces the running timer instead of adding a second one", async () => {
    startPingTimer()
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS / 2)
    startPingTimer()

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS / 2)
    expect(recordPing).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 3)
    expect(recordPing).toHaveBeenCalledTimes(3)
  })
})

describe("ping job logging", () => {
  test("logs the id, status and duration of a ping that succeeded", async () => {
    vi.mocked(recordPing).mockResolvedValue(buildPing())
    const infoLog = vi.spyOn(logger, "info")
    startPingTimer()

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)

    expect(infoLog).toHaveBeenLastCalledWith({ pingId: 7, statusCode: 200, durationMs: 187 }, "Ping succeeded")
  })

  test("logs a warning with the error of a ping that failed", async () => {
    const failedPing = buildPing({ statusCode: null, response: null, error: "Request to httpbin failed: fetch failed" })
    vi.mocked(recordPing).mockResolvedValue(failedPing)
    const warnLog = vi.spyOn(logger, "warn")
    startPingTimer()

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)

    expect(warnLog).toHaveBeenCalledExactlyOnceWith(
      { pingId: 7, statusCode: null, durationMs: 187, error: "Request to httpbin failed: fetch failed" },
      "Ping failed",
    )
  })

  test("logs an error when the job throws, and keeps the timer running", async () => {
    vi.mocked(recordPing).mockRejectedValueOnce(new Error("database is down")).mockResolvedValueOnce(buildPing())
    const errorLog = vi.spyOn(logger, "error")
    const infoLog = vi.spyOn(logger, "info")
    startPingTimer()

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)
    expect(errorLog).toHaveBeenCalledExactlyOnceWith(
      { err: new Error("database is down") },
      "Ping job failed, trying again at the next tick",
    )

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)
    expect(recordPing).toHaveBeenCalledTimes(2)
    expect(infoLog).toHaveBeenLastCalledWith({ pingId: 7, statusCode: 200, durationMs: 187 }, "Ping succeeded")
  })
})

describe("ping job incident check", () => {
  test("checks the saved ping for an incident and logs one that was recorded", async () => {
    const ping = buildPing({ durationMs: 420 })
    vi.mocked(recordPing).mockResolvedValue(ping)
    vi.mocked(reportIncidentForPing).mockResolvedValue(buildIncident())
    const warnLog = vi.spyOn(logger, "warn")
    startPingTimer()

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)

    expect(reportIncidentForPing).toHaveBeenCalledExactlyOnceWith(ping)
    expect(warnLog).toHaveBeenCalledExactlyOnceWith(
      { incidentId: 3, pingId: 7, severity: "warning", reportStatus: "written" },
      "Incident recorded",
    )
  })

  test("logs no incident when the ping isn't one", async () => {
    vi.mocked(recordPing).mockResolvedValue(buildPing())
    const warnLog = vi.spyOn(logger, "warn")
    const errorLog = vi.spyOn(logger, "error")
    startPingTimer()

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)

    expect(reportIncidentForPing).toHaveBeenCalledOnce()
    expect(warnLog).not.toHaveBeenCalled()
    expect(errorLog).not.toHaveBeenCalled()
  })

  test("logs a failed incident check with the ping's id, keeps the ping's own log, and keeps the timer running", async () => {
    vi.mocked(recordPing).mockResolvedValue(buildPing())
    vi.mocked(reportIncidentForPing).mockRejectedValueOnce(new Error("incident table is locked"))
    const errorLog = vi.spyOn(logger, "error")
    const infoLog = vi.spyOn(logger, "info")
    startPingTimer()

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)
    expect(infoLog).toHaveBeenCalledWith({ pingId: 7, statusCode: 200, durationMs: 187 }, "Ping succeeded")
    expect(errorLog).toHaveBeenCalledExactlyOnceWith(
      { err: new Error("incident table is locked"), pingId: 7 },
      "Ping was saved but its incident check failed",
    )

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)
    expect(recordPing).toHaveBeenCalledTimes(2)
    expect(reportIncidentForPing).toHaveBeenCalledTimes(2)
    expect(errorLog).toHaveBeenCalledOnce()
  })

  test("doesn't check for an incident when saving the ping failed", async () => {
    vi.mocked(recordPing).mockRejectedValue(new Error("database is down"))
    startPingTimer()

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)

    expect(reportIncidentForPing).not.toHaveBeenCalled()
  })
})

describe("shutdown", () => {
  test("on SIGTERM or SIGINT, stops the timer, ends every open stream and refuses new ones", async () => {
    const signalListeners = vi.spyOn(process, "once").mockReturnValue(process)
    const streams = [await openTestStream(openStreamRoute), await openTestStream(openStreamRoute)]
    startPingTimer()
    stopPingTimerAndStreamsOnShutdown()

    const [[firstSignal, stopOnSigterm], [secondSignal, stopOnSigint]] = signalListeners.mock.calls
    expect([firstSignal, secondSignal]).toStrictEqual(["SIGTERM", "SIGINT"])
    expect(stopOnSigint).toBe(stopOnSigterm)

    stopOnSigterm("SIGTERM")
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 3)

    expect(recordPing).not.toHaveBeenCalled()
    expect(await Promise.all(streams.map(async ({ reader }) => (await reader.read()).done))).toStrictEqual([true, true])
    const refusedStream = await openStreamRoute(buildStreamRequest(new AbortController().signal))
    expect(refusedStream.status).toBe(503)
    expect(refusedStream.headers.get("connection")).toBe("close")
  })
})
