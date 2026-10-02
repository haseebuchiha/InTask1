import { setTimeout as delay } from "node:timers/promises"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { logger } from "@/config/logger"
import { database } from "@/db/client"
import type { Ping } from "@/db/generated/client"
import { broadcastPing, openPingStream } from "@/services/live-updates"
import { recordPing } from "@/services/ping"
import { deletePingsByPayload } from "../support/database"
import { closeTestStreams, openTestStream, parseEvent, readUntil } from "../support/event-stream"
import { echoLikeHttpbin, HTTPBIN_URL, readSentPayload, readSentRequestIds } from "../support/httpbin"

vi.mock("@/services/live-updates", { spy: true })

const fetchStub = vi.fn<typeof fetch>()

const originalTimeout = AbortSignal.timeout.bind(AbortSignal)

const sentPayloadAt = (callIndex: number) => readSentPayload(fetchStub.mock.calls[callIndex][1])

const replyWith = (status: number, body: string) =>
  new Response(body, { status, headers: { "Content-Type": "application/json" } })

const echoAfterDelay = async (input: unknown, requestOptions?: RequestInit) => {
  await delay(60)
  return echoLikeHttpbin(input, requestOptions)
}

const echoWith = (changes: Record<string, unknown>) => async (_input: unknown, requestOptions?: RequestInit) =>
  Response.json({ json: readSentPayload(requestOptions), url: HTTPBIN_URL, ...changes })

const echoWithReorderedKeys = async (_input: unknown, requestOptions?: RequestInit) => {
  const sentPayload = readSentPayload(requestOptions)
  const reorderedPayload = Object.fromEntries(Object.entries(sentPayload).toReversed())
  return Response.json({ json: reorderedPayload, origin: "203.0.113.7" })
}

const echoWithChangedPriority = async (_input: unknown, requestOptions?: RequestInit) => {
  const sentPayload = readSentPayload(requestOptions)
  return Response.json({ json: { ...sentPayload, priority: 99 }, origin: "203.0.113.7" })
}

const waitForAbort = (_input: unknown, requestOptions?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = requestOptions!.signal!
    signal.addEventListener("abort", () => reject(signal.reason))
  })

const expectWholeNumberBetween = (value: number, lowest: number, highest: number) => {
  expect(Number.isInteger(value)).toBe(true)
  expect(value).toBeGreaterThanOrEqual(lowest)
  expect(value).toBeLessThanOrEqual(highest)
}

const expectSaved = async (ping: Ping) => {
  expect(await database.ping.findUnique({ where: { id: ping.id } })).toStrictEqual(ping)
}

const shortenRequestTimeout = () => vi.spyOn(AbortSignal, "timeout").mockImplementation(() => originalTimeout(20))

beforeEach(() => {
  vi.stubGlobal("fetch", fetchStub)
})

afterEach(async () => {
  closeTestStreams()
  await deletePingsByPayload("requestId", readSentRequestIds(fetchStub))
})

describe("recordPing: the request", () => {
  test("sends a different random payload on every call and saves each one as sent", async () => {
    fetchStub.mockImplementation(echoLikeHttpbin)

    const pings = [await recordPing(), await recordPing(), await recordPing()]
    const sentPayloads = pings.map((_ping, callIndex) => sentPayloadAt(callIndex))

    pings.forEach((ping, callIndex) => expect(ping.payload).toStrictEqual(sentPayloads[callIndex]))
    expect(new Set(sentPayloads.map((payload) => payload.requestId)).size).toBe(3)
  })

  test("POSTs the payload as JSON to httpbin.org/anything with a 30-second timeout signal", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout")
    fetchStub.mockImplementation(echoLikeHttpbin)

    const ping = await recordPing()

    expect(timeoutSpy).toHaveBeenCalledExactlyOnceWith(30_000)
    const timeoutSignal = timeoutSpy.mock.results[0].value
    expect(timeoutSignal).toBeInstanceOf(AbortSignal)
    expect(fetchStub).toHaveBeenCalledExactlyOnceWith(HTTPBIN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: expect.any(String),
      signal: timeoutSignal,
    })
    expect(sentPayloadAt(0)).toStrictEqual(ping.payload)
  })
})

describe("recordPing: what gets saved", () => {
  test("saves the status code, a measured whole-millisecond duration, the parsed reply and a null error on success", async () => {
    fetchStub.mockImplementation(echoAfterDelay)

    const ping = await recordPing()

    expect(ping).toMatchObject({
      statusCode: 200,
      response: { json: sentPayloadAt(0), method: "POST", url: HTTPBIN_URL },
      error: null,
    })
    expectWholeNumberBetween(ping.durationMs, 50, 5000)
    await expectSaved(ping)
  })

  test.each([
    { status: 404, body: JSON.stringify({ message: "not found" }), response: { message: "not found" } },
    { status: 500, body: "", response: null },
    { status: 503, body: "<html>Service Unavailable</html>", response: null },
  ])("keeps the status code and sets error for a $status reply", async ({ status, body, response }) => {
    fetchStub.mockResolvedValue(replyWith(status, body))

    const ping = await recordPing()

    expect(ping).toMatchObject({ statusCode: status, response, error: `httpbin answered with status ${status}` })
    expectWholeNumberBetween(ping.durationMs, 0, 5000)
    await expectSaved(ping)
  })

  test("leaves statusCode and response null and sets error when the request times out", async () => {
    shortenRequestTimeout()
    fetchStub.mockImplementation(waitForAbort)

    const ping = await recordPing()

    expect(ping).toMatchObject({
      statusCode: null,
      response: null,
      error: "Request to httpbin failed: The operation was aborted due to timeout",
    })
    expectWholeNumberBetween(ping.durationMs, 15, 5000)
    await expectSaved(ping)
  })

  test("leaves statusCode and response null and sets error when the request is aborted", async () => {
    fetchStub.mockRejectedValue(new DOMException("This operation was aborted", "AbortError"))

    const ping = await recordPing()

    expect(ping).toMatchObject({
      statusCode: null,
      response: null,
      error: "Request to httpbin failed: This operation was aborted",
    })
    await expectSaved(ping)
  })

  test.each([
    {
      name: "a network error with an empty message falls back to its code",
      failure: new TypeError("fetch failed", {
        cause: Object.assign(new AggregateError([], ""), { code: "ECONNREFUSED" }),
      }),
      error: "Request to httpbin failed: fetch failed: ECONNREFUSED",
    },
    {
      name: "an empty-message error at the top falls back to its code",
      failure: Object.assign(new Error(""), { code: "ENOTFOUND" }),
      error: "Request to httpbin failed: ENOTFOUND",
    },
    {
      name: "an empty-message error with no code falls back to its name",
      failure: new AggregateError([], ""),
      error: "Request to httpbin failed: AggregateError",
    },
    {
      name: "a nested cause chain appears in full",
      failure: new TypeError("fetch failed", {
        cause: new Error("connect ETIMEDOUT 3.210.94.60:443", { cause: new Error("socket hang up") }),
      }),
      error: "Request to httpbin failed: fetch failed: connect ETIMEDOUT 3.210.94.60:443: socket hang up",
    },
    {
      name: "a cause that isn't an Error is written as text",
      failure: new TypeError("fetch failed", { cause: "certificate has expired" }),
      error: "Request to httpbin failed: fetch failed: certificate has expired",
    },
    {
      name: "a rejection that isn't an Error is written as text",
      failure: "offline",
      error: "Request to httpbin failed: offline",
    },
  ])("describes the failure: $name", async ({ failure, error }) => {
    fetchStub.mockRejectedValue(failure)

    const ping = await recordPing()

    expect(ping).toMatchObject({ statusCode: null, response: null, error })
    await expectSaved(ping)
  })

  test.each(["<html>not json</html>", "", "null"])("leaves response null for the non-JSON body %j", async (body) => {
    fetchStub.mockResolvedValue(replyWith(200, body))

    const ping = await recordPing()

    expect(ping).toMatchObject({ statusCode: 200, response: null, error: null })
    await expectSaved(ping)
  })
})

describe("recordPing: the response kind and origin", () => {
  test("tags an exact echo as clean_echo and keeps httpbin's origin", async () => {
    fetchStub.mockImplementation(echoWith({ origin: "203.0.113.7" }))

    const ping = await recordPing()

    expect(ping).toMatchObject({ responseKind: "clean_echo", origin: "203.0.113.7" })
    await expectSaved(ping)
  })

  test("tags an echo with the same fields in another order as clean_echo", async () => {
    fetchStub.mockImplementation(echoWithReorderedKeys)

    expect(await recordPing()).toMatchObject({ responseKind: "clean_echo", origin: "203.0.113.7" })
  })

  test("tags an echo that differs from the payload as echo_mismatch", async () => {
    fetchStub.mockImplementation(echoWithChangedPriority)

    expect(await recordPing()).toMatchObject({ responseKind: "echo_mismatch", origin: "203.0.113.7" })
  })

  test.each([
    { name: "a JSON body without the echo", body: JSON.stringify({ origin: "203.0.113.7" }), origin: "203.0.113.7" },
    { name: "a JSON list", body: "[1, 2]", origin: null },
    { name: "a JSON string", body: JSON.stringify("hello"), origin: null },
  ])("tags $name as echo_mismatch", async ({ body, origin }) => {
    fetchStub.mockResolvedValue(replyWith(200, body))

    expect(await recordPing()).toMatchObject({ responseKind: "echo_mismatch", origin })
  })

  test.each(["<html>not json</html>", "", "null"])("tags a 200 with the non-JSON body %j as empty", async (body) => {
    fetchStub.mockResolvedValue(replyWith(200, body))

    expect(await recordPing()).toMatchObject({ statusCode: 200, responseKind: "empty", origin: null })
  })

  test.each([
    { status: 400, responseKind: "client_error" },
    { status: 404, responseKind: "client_error" },
    { status: 499, responseKind: "client_error" },
    { status: 500, responseKind: "gateway_error" },
    { status: 502, responseKind: "gateway_error" },
    { status: 504, responseKind: "gateway_error" },
  ])("tags a $status reply as $responseKind", async ({ status, responseKind }) => {
    fetchStub.mockResolvedValue(replyWith(status, JSON.stringify({ origin: "203.0.113.7" })))

    const ping = await recordPing()

    expect(ping).toMatchObject({ statusCode: status, responseKind, origin: "203.0.113.7" })
    await expectSaved(ping)
  })

  test("tags a request that got no reply as failed, with no origin", async () => {
    fetchStub.mockRejectedValue(new TypeError("fetch failed"))

    const ping = await recordPing()

    expect(ping).toMatchObject({ statusCode: null, responseKind: "failed", origin: null })
    await expectSaved(ping)
  })

  test("leaves origin null when httpbin's origin isn't text", async () => {
    fetchStub.mockImplementation(echoWith({ origin: ["203.0.113.7"] }))

    expect(await recordPing()).toMatchObject({ responseKind: "clean_echo", origin: null })
  })
})

describe("recordPing: the broadcast", () => {
  test.each([
    {
      name: "a successful ping",
      reply: echoLikeHttpbin,
      expectedFields: { statusCode: 200, error: null, responseKind: "clean_echo", origin: null },
    },
    {
      name: "a failed ping, with its error and a null statusCode",
      reply: () => Promise.reject(new TypeError("fetch failed")),
      expectedFields: {
        statusCode: null,
        error: "Request to httpbin failed: fetch failed",
        responseKind: "failed",
        origin: null,
      },
    },
  ])(
    "streams the saved row to an open stream as a PingRow with exactly seven fields and an ISO createdAt: $name",
    async ({ reply, expectedFields }) => {
      const { reader } = await openTestStream(openPingStream)
      fetchStub.mockImplementation(reply)

      const ping = await recordPing()
      const { event, payload } = parseEvent(await readUntil(reader, "event"))

      expect(event).toBe("ping")
      expect(payload).toStrictEqual({
        id: ping.id,
        createdAt: ping.createdAt.toISOString(),
        durationMs: ping.durationMs,
        ...expectedFields,
      })
      expect(
        await database.ping.findUnique({ where: { id: payload.id }, omit: { payload: true, response: true } }),
      ).toStrictEqual({
        ...payload,
        createdAt: new Date(payload.createdAt),
      })
      expect(broadcastPing).toHaveBeenCalledOnce()
    },
  )

  test("still resolves with the saved row, and logs, when the broadcast throws", async () => {
    vi.mocked(broadcastPing).mockImplementationOnce(() => {
      throw new Error("stream exploded")
    })
    const errorLog = vi.spyOn(logger, "error")
    fetchStub.mockImplementation(echoLikeHttpbin)

    const ping = await recordPing()

    expect(ping).toMatchObject({ statusCode: 200, error: null })
    await expectSaved(ping)
    expect(errorLog).toHaveBeenCalledExactlyOnceWith(
      { err: new Error("stream exploded"), pingId: ping.id },
      expect.any(String),
    )
  })
})
