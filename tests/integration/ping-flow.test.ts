import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { GET as openStreamRoute } from "@/app/api/pings/stream/route"
import { PING_INTERVAL_MS } from "@/config/env"
import { database } from "@/db/client"
import { startPingTimer } from "@/jobs/ping"
import { deleteIncidentsByPingPayload, deletePingsByPayload } from "../support/database"
import { closeTestStreams, openTestStream, parseEvent, readUntil } from "../support/event-stream"
import { echoLikeHttpbin, readSentRequestIds } from "../support/httpbin"

vi.mock("@/services/llm", () => ({ generateStructured: vi.fn(), hasLlmBudget: async () => false }))

const fetchStub = vi.fn(echoLikeHttpbin)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  vi.stubGlobal("fetch", fetchStub)
})

afterEach(async () => {
  vi.clearAllTimers()
  vi.useRealTimers()
  closeTestStreams()
  await deleteIncidentsByPingPayload("requestId", readSentRequestIds(fetchStub))
  await deletePingsByPayload("requestId", readSentRequestIds(fetchStub))
})

describe("from the timer to an open dashboard", () => {
  test("a timer tick pings httpbin, saves the row, and streams that same row to an open stream", async () => {
    const { reader } = await openTestStream(openStreamRoute)
    startPingTimer()

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS - 1)
    expect(fetchStub).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    const { event, payload } = parseEvent(await readUntil(reader, "event"))
    const savedPing = await database.ping.findFirstOrThrow({
      where: { payload: { path: ["requestId"], equals: readSentRequestIds(fetchStub)[0] } },
    })

    expect(event).toBe("ping")
    expect(fetchStub).toHaveBeenCalledOnce()
    expect(payload).toStrictEqual({
      id: savedPing.id,
      createdAt: savedPing.createdAt.toISOString(),
      statusCode: 200,
      durationMs: savedPing.durationMs,
      error: null,
      responseKind: "clean_echo",
      origin: null,
    })
  })
})
