import { randomInt, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { GET as findIncidentRoute } from "@/app/api/incidents/[id]/route"
import { GET as listIncidentsRoute } from "@/app/api/incidents/route"
import { database } from "@/db/client"
import type { Incident } from "@/db/generated/client"
import { deleteIncidentsByPingPayload, deletePingsByPayload } from "../support/database"

const MILLISECONDS_PER_MINUTE = 60 * 1000

const MILLISECONDS_PER_HOUR = 60 * MILLISECONDS_PER_MINUTE

const OLDER_INCIDENT_COUNT = 48

type IncidentListBody = {
  incidents: (Omit<Incident, "createdAt"> & { createdAt: string; ping: Record<string, unknown> })[]
}

const testDay = new Date(Date.UTC(3000, 0, 2) + randomInt(0, 36_000) * 24 * MILLISECONDS_PER_HOUR)

const runMarker = { seeded: true, suite: "tests/api/incidents", runId: randomUUID() }

const seededIncidents: Incident[] = []

const hourOf = (hour: number) => new Date(testDay.getTime() + hour * MILLISECONDS_PER_HOUR)

const seedIncident = async (hour: number) => {
  const ping = await database.ping.create({
    data: {
      createdAt: hourOf(hour),
      payload: { ...runMarker, hour },
      statusCode: 200,
      durationMs: 400 + hour,
      responseKind: "empty",
    },
  })
  const incident = await database.incident.create({
    data: {
      createdAt: hourOf(hour),
      pingId: ping.id,
      severity: hour === 3 ? "critical" : "warning",
      durationMs: ping.durationMs,
      averageDurationMs: 150,
      reportStatus: "written",
      summary: `Seeded incident at hour ${hour}`,
      likelyCauses: ["httpbin was slow", "The network was congested"],
      recommendations: ["Watch the next pings", "Check httpbin's status"],
      inputTokens: 800 + hour,
      outputTokens: 90 + hour,
    },
  })
  seededIncidents.push(incident)
}

const failedPingAtMinute = (minute: number) => ({
  createdAt: new Date(testDay.getTime() + minute * MILLISECONDS_PER_MINUTE),
  payload: { ...runMarker, minute },
  durationMs: 30_000,
  error: "Seeded failure",
  responseKind: "failed",
})

const seedOlderIncidents = async () => {
  const pings = await database.ping.createManyAndReturn({
    data: Array.from({ length: OLDER_INCIDENT_COUNT }, (_, minute) => failedPingAtMinute(minute)),
  })
  await database.incident.createMany({
    data: pings.map((ping) => ({
      createdAt: ping.createdAt,
      pingId: ping.id,
      severity: "critical",
      durationMs: ping.durationMs,
      averageDurationMs: 150,
      reportStatus: "skipped_budget",
    })),
  })
}

const requestIncidentList = async () => {
  const response = await listIncidentsRoute()
  return { status: response.status, body: (await response.json()) as IncidentListBody }
}

const requestIncident = async (id: string) => {
  const response = await findIncidentRoute(new Request(`http://localhost/api/incidents/${id}`), {
    params: Promise.resolve({ id }),
  })
  return { status: response.status, body: await response.json() }
}

const seededIds = () => seededIncidents.map((incident) => incident.id)

beforeAll(async () => {
  await seedOlderIncidents()
  await seedIncident(1)
  await seedIncident(2)
  await seedIncident(3)
})

afterAll(async () => {
  await deleteIncidentsByPingPayload("runId", [runMarker.runId])
  await deletePingsByPayload("runId", [runMarker.runId])
})

describe("GET /api/incidents", () => {
  test("returns the 50 newest incidents, newest first, each with a light ping summary", async () => {
    const { status, body } = await requestIncidentList()

    expect(status).toBe(200)
    expect(Object.keys(body)).toStrictEqual(["incidents"])
    expect(body.incidents).toHaveLength(50)
    const createdAtTimes = body.incidents.map((incident) => new Date(incident.createdAt).getTime())
    expect(createdAtTimes).toStrictEqual(createdAtTimes.toSorted((first, second) => second - first))
    body.incidents.forEach((incident) =>
      expect(Object.keys(incident.ping).toSorted()).toStrictEqual(["createdAt", "error", "id", "statusCode"]),
    )
  })

  test("includes the seeded incidents newest first, with their reports", async () => {
    const { body } = await requestIncidentList()
    const listedSeeds = body.incidents.filter((incident) => seededIds().includes(incident.id))

    expect(listedSeeds.map((incident) => incident.id)).toStrictEqual(seededIds().toReversed())
    expect(listedSeeds[0]).toMatchObject({
      createdAt: hourOf(3).toISOString(),
      severity: "critical",
      durationMs: 403,
      averageDurationMs: 150,
      reportStatus: "written",
      summary: "Seeded incident at hour 3",
      likelyCauses: ["httpbin was slow", "The network was congested"],
      inputTokens: 803,
      outputTokens: 93,
      ping: { id: seededIncidents[2].pingId, createdAt: hourOf(3).toISOString(), statusCode: 200, error: null },
    })
  })
})

describe("GET /api/incidents/:id", () => {
  test("returns one incident in full", async () => {
    const incident = seededIncidents[1]
    const { status, body } = await requestIncident(String(incident.id))

    expect(status).toBe(200)
    expect(body).toStrictEqual({ ...incident, createdAt: hourOf(2).toISOString() })
  })

  test("returns 404 for an id with no incident", async () => {
    const { status, body } = await requestIncident("999999999")

    expect(status).toBe(404)
    expect(body).toStrictEqual({ error: "No incident with id 999999999" })
  })

  test.each(["abc", "12abc", "-1", "0", "1.5", "Infinity", "2147483648"])(
    "rejects the invalid id %s with a 400",
    async (id) => {
      const { status, body } = await requestIncident(id)

      expect(status).toBe(400)
      expect(body).toStrictEqual({ error: "Incident id must be a whole number from 1 to 2147483647" })
    },
  )
})
