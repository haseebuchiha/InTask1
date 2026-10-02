import { setTimeout as delay } from "node:timers/promises"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { GET } from "@/app/api/pings/stream/route"
import type { Incident } from "@/db/generated/client"
import type { PingRow } from "@/lib/ping-row"
import { broadcastIncident, broadcastPing } from "@/services/live-updates"
import { buildStreamRequest, closeTestStreams, openTestStream, parseEvent, readUntil } from "../support/event-stream"

const PING_ROW: PingRow = {
  id: 42,
  createdAt: "2026-09-30T12:00:00.000Z",
  statusCode: 200,
  durationMs: 187,
  error: null,
  responseKind: "clean_echo",
  origin: "203.0.113.7",
}

const incident: Incident = {
  id: 9,
  createdAt: new Date("2026-09-30T12:00:01.000Z"),
  pingId: 42,
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
}

const openStream = () => openTestStream(GET)

afterEach(closeTestStreams)

describe("live updates", () => {
  test("opens an event stream that nginx won't buffer, on a connection that closes when the stream ends", async () => {
    const { response } = await openStream()

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    expect(response.headers.get("x-accel-buffering")).toBe("no")
    expect(response.headers.get("connection")).toBe("close")
  })

  test("sends a broadcast ping to an open stream as a ping event with exactly the row's fields", async () => {
    const { reader } = await openStream()

    broadcastPing(PING_ROW)
    const message = await readUntil(reader, "event")

    expect(parseEvent(message)).toStrictEqual({ event: "ping", payload: PING_ROW })
  })

  test("sends a broadcast incident to an open stream as an incident event with the saved row", async () => {
    const { reader } = await openStream()

    broadcastIncident(incident)
    const message = await readUntil(reader, "event")

    expect(parseEvent(message)).toStrictEqual({
      event: "incident",
      payload: { ...incident, createdAt: "2026-09-30T12:00:01.000Z" },
    })
  })

  test("sends each ping to every open stream", async () => {
    const firstStream = await openStream()
    const secondStream = await openStream()

    broadcastPing(PING_ROW)

    expect(parseEvent(await readUntil(firstStream.reader, "event")).payload).toStrictEqual(PING_ROW)
    expect(parseEvent(await readUntil(secondStream.reader, "event")).payload).toStrictEqual(PING_ROW)
  })

  test("stops sending to a stream once its viewer disconnects", async () => {
    const { reader, disconnect } = await openStream()

    disconnect.abort()

    expect(() => broadcastPing(PING_ROW)).not.toThrow()
    expect((await reader.read()).done).toBe(true)
  })
})

const unhandledRejections: unknown[] = []

const recordUnhandledRejection = (reason: unknown) => {
  unhandledRejections.push(reason)
}

const openStreamThatHangsUpAtOnce = async () => {
  const disconnect = new AbortController()
  const response = await GET(buildStreamRequest(disconnect.signal))
  disconnect.abort()
  return response
}

const expectPingOnEveryStream = async (streams: Awaited<ReturnType<typeof openStream>>[]) => {
  const messages = await Promise.all(streams.map(({ reader }) => readUntil(reader, "event")))
  expect(messages.map((message) => parseEvent(message).payload)).toStrictEqual(streams.map(() => PING_ROW))
}

describe("live updates when one viewer's stream breaks", () => {
  beforeEach(() => {
    unhandledRejections.length = 0
    process.on("unhandledRejection", recordUnhandledRejection)
  })

  afterEach(async () => {
    await delay(20)
    process.off("unhandledRejection", recordUnhandledRejection)
  })

  test("still reaches the streams opened after a viewer who disconnected", async () => {
    const brokenStream = await openStream()
    const healthyStreams = [await openStream(), await openStream()]

    brokenStream.disconnect.abort()

    expect(() => broadcastPing(PING_ROW)).not.toThrow()
    await expectPingOnEveryStream(healthyStreams)
    await delay(20)
    expect(unhandledRejections).toStrictEqual([])
  })

  test("still reaches the other streams, with no unhandled rejection, when a viewer stops reading without disconnecting", async () => {
    const brokenStream = await openStream()
    const healthyStreams = [await openStream(), await openStream()]

    await brokenStream.reader.cancel()

    expect(() => broadcastPing(PING_ROW)).not.toThrow()
    await expectPingOnEveryStream(healthyStreams)
    await delay(20)
    expect(unhandledRejections).toStrictEqual([])
  })

  test("drops a viewer who hangs up before the stream starts, with no unhandled rejection", async () => {
    const hungUpStream = await openStreamThatHangsUpAtOnce()
    const healthyStreams = [await openStream(), await openStream()]

    expect(() => broadcastPing(PING_ROW)).not.toThrow()
    await expectPingOnEveryStream(healthyStreams)
    await delay(20)

    expect(unhandledRejections).toStrictEqual([])
    expect(await hungUpStream.text()).not.toContain("event:")
  })

  test("ends the stream of a viewer who left before it was opened instead of keeping it registered", async () => {
    const leftStream = await GET(buildStreamRequest(AbortSignal.abort()))
    await openStream()

    broadcastPing(PING_ROW)

    expect(await leftStream.text()).not.toContain("event:")
  })
})
