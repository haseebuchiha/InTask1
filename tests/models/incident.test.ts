import { randomInt, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { database } from "@/db/client"
import { chatQuerySchema, type IncidentChatQuery } from "@/lib/chat-query"
import { createIncident, queryIncidents } from "@/models/incident"
import { listRecentDurations } from "@/models/ping"
import { deleteIncidentsByPingIds, deletePingsByPayload } from "../support/database"

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000

const windowStart = new Date(Date.UTC(4000, 0, 1) + randomInt(0, 36_000) * 24 * MILLISECONDS_PER_HOUR)

const hourOf = (hour: number) => new Date(windowStart.getTime() + hour * MILLISECONDS_PER_HOUR)

const runMarker = { seeded: true, suite: "tests/models/incident", runId: randomUUID() }

const seededPingIds: number[] = []

const seedPing = async (hour: number, durationMs: number, error: string | null = null) => {
  const ping = await database.ping.create({
    data: { createdAt: hourOf(hour), payload: { ...runMarker, hour }, durationMs, error, responseKind: "failed" },
  })
  seededPingIds.push(ping.id)
}

const incidentFields = (pingIndex: number, reportStatus: string) => ({
  ping: { connect: { id: seededPingIds[pingIndex] } },
  severity: "warning",
  durationMs: 900,
  averageDurationMs: 300,
  reportStatus,
})

const seedIncident = (hour: number, reportStatus: string, tokens: number) =>
  createIncident({
    ...incidentFields(hour - 1, reportStatus),
    createdAt: hourOf(hour),
    inputTokens: tokens,
    outputTokens: tokens * 2,
  })

const incidentQuery = (method: string, queryArguments: Record<string, unknown>) =>
  chatQuerySchema.parse({ table: "incident", method, arguments: queryArguments }) as IncidentChatQuery

const seededWindow = () => ({ createdAt: { gte: hourOf(1).toISOString(), lte: hourOf(3).toISOString() } })

beforeAll(async () => {
  await seedPing(1, 100)
  await seedPing(2, 300)
  await seedPing(3, 5000, "Seeded failure")
  await seedIncident(1, "written", 4)
  await seedIncident(2, "written", 10)
  await seedIncident(3, "skipped_budget", 0)
})

afterAll(async () => {
  await deleteIncidentsByPingIds(seededPingIds)
  await deletePingsByPayload("runId", [runMarker.runId])
})

describe("queryIncidents", () => {
  test("finds incidents with every column unless the query selects some", async () => {
    const rows = (await queryIncidents(
      incidentQuery("findMany", { where: seededWindow(), orderBy: [{ createdAt: "desc" }] }),
    )) as Record<string, unknown>[]
    const selected = await queryIncidents(
      incidentQuery("findMany", {
        where: { ...seededWindow(), reportStatus: "written" },
        orderBy: [{ createdAt: "asc" }],
        select: { inputTokens: true },
      }),
    )

    expect(rows.map((row) => row.reportStatus)).toStrictEqual(["skipped_budget", "written", "written"])
    expect(Object.keys(rows[0])).toStrictEqual([
      "id",
      "createdAt",
      "pingId",
      "severity",
      "durationMs",
      "averageDurationMs",
      "reportStatus",
      "summary",
      "likelyCauses",
      "recommendations",
      "inputTokens",
      "cachedInputTokens",
      "outputTokens",
    ])
    expect(selected).toStrictEqual([{ inputTokens: 4 }, { inputTokens: 10 }])
  })

  test("aggregates and groups incidents", async () => {
    const totals = await queryIncidents(
      incidentQuery("aggregate", {
        where: seededWindow(),
        _sum: { inputTokens: true, outputTokens: true },
        _avg: { averageDurationMs: true },
      }),
    )
    const groups = await queryIncidents(
      incidentQuery("groupBy", {
        where: seededWindow(),
        by: ["reportStatus"],
        _count: true,
        orderBy: [{ reportStatus: "asc" }],
      }),
    )

    expect(totals).toStrictEqual({ _sum: { inputTokens: 14, outputTokens: 28 }, _avg: { averageDurationMs: 300 } })
    expect(groups).toStrictEqual([
      { reportStatus: "skipped_budget", _count: 1 },
      { reportStatus: "written", _count: 2 },
    ])
  })
})

describe("ping duration reads", () => {
  test("lists recent durations newest first", async () => {
    const durations = await listRecentDurations(3)

    expect(durations).toStrictEqual([
      { durationMs: 5000, error: "Seeded failure" },
      { durationMs: 300, error: null },
      { durationMs: 100, error: null },
    ])
  })
})
