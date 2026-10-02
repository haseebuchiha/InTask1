import { randomInt, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { database } from "@/db/client"
import { chatQuerySchema, type PingChatQuery } from "@/lib/chat-query"
import { listPingOutcomesBetween, queryPings } from "@/models/ping"
import { deletePingsByPayload } from "../support/database"

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000

const NO_REPLY_FIELDS = { statusCode: null, error: "Seeded failure", responseKind: "failed" }

const windowStart = new Date(Date.UTC(2100, 0, 1) + randomInt(0, 7000) * 24 * MILLISECONDS_PER_HOUR)

const hourOf = (hour: number) => new Date(windowStart.getTime() + hour * MILLISECONDS_PER_HOUR)

const runMarker = { seeded: true, suite: "tests/models/ping", runId: randomUUID() }

const inWindow = { createdAt: { gte: hourOf(0).toISOString(), lt: hourOf(10).toISOString() } }

const pingQuery = (method: string, queryArguments: Record<string, unknown>) =>
  chatQuerySchema.parse({ table: "ping", method, arguments: queryArguments }) as PingChatQuery

const replyFields = (hour: number, statusCode: number) => ({
  statusCode,
  response: { echoed: hour },
  error: null,
  responseKind: "echo_mismatch",
  origin: "203.0.113.7",
})

const seedPing = (hour: number, durationMs: number, statusCode: number | null) =>
  database.ping.create({
    data: {
      createdAt: hourOf(hour),
      payload: { ...runMarker, hour },
      durationMs,
      ...(statusCode === null ? NO_REPLY_FIELDS : replyFields(hour, statusCode)),
    },
  })

beforeAll(async () => {
  await seedPing(1, 100, 200)
  await seedPing(2, 300, 200)
  await seedPing(3, 5000, null)
  await seedPing(4, 200, 503)
  await seedPing(47, 111, 200)
  await seedPing(48, 120, 200)
  await seedPing(50, 30_000, null)
  await seedPing(71, 140, 502)
  await seedPing(72, 150, 200)
})

afterAll(async () => {
  await deletePingsByPayload("runId", [runMarker.runId])
})

describe("queryPings", () => {
  test("finds rows without the payload and the response unless the query selects them", async () => {
    const rows = (await queryPings(
      pingQuery("findMany", { where: inWindow, orderBy: [{ createdAt: "asc" }] }),
    )) as Record<string, unknown>[]

    expect(rows.map((row) => row.durationMs)).toStrictEqual([100, 300, 5000, 200])
    expect(Object.keys(rows[0]).toSorted()).toStrictEqual([
      "createdAt",
      "durationMs",
      "error",
      "id",
      "origin",
      "responseKind",
      "statusCode",
    ])
  })

  test("returns the payload and the response when the query selects them", async () => {
    const rows = await queryPings(
      pingQuery("findMany", {
        where: { ...inWindow, error: null },
        orderBy: [{ durationMs: "desc" }],
        select: { payload: true, response: true },
        take: 1,
      }),
    )

    expect(rows).toStrictEqual([{ payload: { ...runMarker, hour: 2 }, response: { echoed: 2 } }])
  })

  test("aggregates counts, averages and extremes", async () => {
    const totals = await queryPings(
      pingQuery("aggregate", {
        where: inWindow,
        _count: true,
        _avg: { durationMs: true },
        _max: { durationMs: true, createdAt: true },
      }),
    )

    expect(totals).toStrictEqual({
      _count: 4,
      _avg: { durationMs: 1400 },
      _max: { durationMs: 5000, createdAt: hourOf(4) },
    })
  })

  test("groups rows with their aggregates", async () => {
    const groups = await queryPings(
      pingQuery("groupBy", {
        where: inWindow,
        by: ["statusCode"],
        _count: true,
        _min: { durationMs: true },
        orderBy: [{ statusCode: "asc" }],
        take: 10,
      }),
    )

    expect(groups).toStrictEqual([
      { statusCode: 200, _count: 2, _min: { durationMs: 100 } },
      { statusCode: 503, _count: 1, _min: { durationMs: 200 } },
      { statusCode: null, _count: 1, _min: { durationMs: 5000 } },
    ])
  })
})

describe("listPingOutcomesBetween", () => {
  test("lists the pings from the start up to but not including the end, oldest first, without payload or response", async () => {
    const outcomes = await listPingOutcomesBetween(hourOf(48), hourOf(72))

    expect(outcomes).toStrictEqual([
      {
        createdAt: hourOf(48),
        statusCode: 200,
        durationMs: 120,
        error: null,
        responseKind: "echo_mismatch",
        origin: "203.0.113.7",
      },
      {
        createdAt: hourOf(50),
        statusCode: null,
        durationMs: 30_000,
        error: "Seeded failure",
        responseKind: "failed",
        origin: null,
      },
      {
        createdAt: hourOf(71),
        statusCode: 502,
        durationMs: 140,
        error: null,
        responseKind: "echo_mismatch",
        origin: "203.0.113.7",
      },
    ])
  })

  test("returns an empty list for a window with no pings", async () => {
    expect(await listPingOutcomesBetween(hourOf(60), hourOf(70))).toStrictEqual([])
  })
})
