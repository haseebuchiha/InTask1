import type { Mock } from "vitest"

export const HTTPBIN_URL = "https://httpbin.org/anything"

export const readSentPayload = (requestOptions?: RequestInit) => JSON.parse(String(requestOptions?.body))

export const readSentRequestIds = (fetchStub: Mock<typeof fetch>): string[] =>
  fetchStub.mock.calls.map(([, requestOptions]) => readSentPayload(requestOptions).requestId)

export const echoLikeHttpbin = async (_input: unknown, requestOptions?: RequestInit) =>
  Response.json({ json: readSentPayload(requestOptions), method: "POST", url: HTTPBIN_URL })
