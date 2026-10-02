import "server-only"
import { randomInt, randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { logger } from "@/config/logger"
import type { Ping, Prisma } from "@/db/generated/client"
import { PING_PAGE_SIZE, type PingHistoryFilters } from "@/lib/ping-filters"
import type { PingRow } from "@/lib/ping-row"
import { createPing, listPings, type PingPageQuery } from "@/models/ping"
import { broadcastPing } from "@/services/live-updates"

export { findPingById } from "@/models/ping"

const HTTPBIN_URL = "https://httpbin.org/anything"

const REQUEST_TIMEOUT_MS = 30_000

const VOCABULARY = [
  "amber",
  "birch",
  "cobalt",
  "delta",
  "ember",
  "falcon",
  "garnet",
  "harbor",
  "indigo",
  "juniper",
  "kestrel",
  "lantern",
  "meadow",
  "nimbus",
  "orchid",
  "pebble",
  "quartz",
  "raven",
  "summit",
  "tundra",
  "umber",
  "velvet",
  "willow",
  "zephyr",
]

type RandomPayload = ReturnType<typeof buildRandomPayload>

type PingWithoutPayloadOrResponse = Omit<Ping, "payload" | "response">

type HttpbinReply = { statusCode?: number; response?: Prisma.InputJsonValue }

type HttpbinMeasurement = HttpbinReply & { error: string | null; durationMs: number }

export const recordPing = async () => {
  const payload = buildRandomPayload()
  const measurement = await measureHttpbinRequest(payload)
  const ping = await createPing({ payload, ...measurement, ...tagResponse(payload, measurement) })
  broadcastSavedPing(ping)
  return ping
}

const buildRandomPayload = () => ({
  requestId: randomUUID(),
  message: pickRandomWords(3).join(" "),
  tags: pickRandomWords(randomInt(1, 4)),
  priority: randomInt(1, 6),
  isUrgent: flipCoin(),
  sensor: buildRandomSensorReading(),
})

const buildRandomSensorReading = () => ({
  serialNumber: randomInt(1000, 10_000),
  temperatureCelsius: randomInt(-200, 450) / 10,
  isOnline: flipCoin(),
})

const pickRandomWords = (count: number) => Array.from({ length: count }, pickRandomWord)

const pickRandomWord = () => VOCABULARY[randomInt(VOCABULARY.length)]

const flipCoin = () => randomInt(2) === 1

const measureHttpbinRequest = async (payload: RandomPayload): Promise<HttpbinMeasurement> => {
  const startedAt = performance.now()
  const replyOrFailure = await postPayloadToHttpbin(payload).then(readHttpbinReply).catch(describeRequestFailure)
  return { ...replyOrFailure, durationMs: Math.round(performance.now() - startedAt) }
}

const postPayloadToHttpbin = (payload: RandomPayload) =>
  fetch(HTTPBIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

const readHttpbinReply = async (reply: Response) => ({
  statusCode: reply.status,
  response: await readJsonBody(reply),
  error: reply.ok ? null : `httpbin answered with status ${reply.status}`,
})

const readJsonBody = async (reply: Response): Promise<Prisma.InputJsonValue | undefined> =>
  (await reply.json().catch(() => undefined)) ?? undefined

const describeRequestFailure = (cause: unknown) => ({
  error: `Request to httpbin failed: ${describeErrorChain(cause)}`,
})

const describeErrorChain = (cause: unknown): string => {
  if (!(cause instanceof Error)) return String(cause)
  if (cause.cause === undefined) return describeOneError(cause)
  return `${describeOneError(cause)}: ${describeErrorChain(cause.cause)}`
}

const describeOneError = (error: Error) => error.message || ("code" in error ? String(error.code) : error.name)

const tagResponse = (payload: RandomPayload, reply: HttpbinReply) => ({
  responseKind: decideResponseKind(payload, reply),
  origin: readOrigin(reply.response),
})

const decideResponseKind = (payload: RandomPayload, { statusCode, response }: HttpbinReply) => {
  if (statusCode === undefined) return "failed"
  if (statusCode >= 400) return decideErrorKind(statusCode)
  return decideAnsweredKind(payload, response)
}

const decideErrorKind = (statusCode: number) => (statusCode >= 500 ? "gateway_error" : "client_error")

const decideAnsweredKind = (payload: RandomPayload, response: Prisma.InputJsonValue | undefined) => {
  if (response === undefined) return "empty"
  return isDeepStrictEqual(readJsonField(response, "json"), payload) ? "clean_echo" : "echo_mismatch"
}

const readOrigin = (response: Prisma.InputJsonValue | undefined) => {
  const origin = readJsonField(response, "origin")
  return typeof origin === "string" ? origin : null
}

const readJsonField = (json: unknown, field: string) => (isJsonObject(json) ? json[field] : undefined)

const isJsonObject = (json: unknown): json is Record<string, unknown> =>
  typeof json === "object" && json !== null && !Array.isArray(json)

const broadcastSavedPing = (ping: Ping) => {
  try {
    broadcastPing(toPingRow(ping))
  } catch (error) {
    logger.error({ err: error, pingId: ping.id }, "Ping was saved but could not be broadcast")
  }
}

export const listPingHistory = async (filters: PingHistoryFilters) => {
  const page = atLeastFirstPage(filters.page)
  const { pings, totalCount } = await listPings(toPingPageQuery({ ...filters, page }))
  return { pings: pings.map(toPingRow), totalCount, page, pageSize: PING_PAGE_SIZE }
}

const atLeastFirstPage = (page: number) => Math.max(page, 1)

const toPingPageQuery = ({ page, from, to, failedOnly }: PingHistoryFilters): PingPageQuery => ({
  page,
  pageSize: PING_PAGE_SIZE,
  from: from ?? undefined,
  to: to ?? undefined,
  onlyWithError: failedOnly,
})

const toPingRow = (ping: PingWithoutPayloadOrResponse): PingRow => ({
  id: ping.id,
  createdAt: ping.createdAt.toISOString(),
  statusCode: ping.statusCode,
  durationMs: ping.durationMs,
  error: ping.error,
  responseKind: ping.responseKind,
  origin: ping.origin,
})
