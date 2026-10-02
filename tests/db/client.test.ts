import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, test } from "vitest"
import { database } from "@/db/client"
import { createPing, findPingById, listPings } from "@/models/ping"
import { deletePingsByPayload } from "../support/database"

const TOLERANCE_MILLISECONDS = 5000

const runMarker = { seeded: true, suite: "tests/db/client", runId: randomUUID() }

const createThroughModel = async () => {
  const ping = await createPing({ payload: runMarker, durationMs: 1, responseKind: "failed" })
  return ping.id
}

const insertWithDatabaseClock = async () => {
  const [row] = await database.$queryRaw<{ id: number }[]>`
    insert into ping (payload, duration_ms, response_kind)
    values (${JSON.stringify(runMarker)}::jsonb, 1, 'failed') returning id`
  return row.id
}

const readStoredMilliseconds = async (id: number) => {
  const [row] = await database.$queryRaw<{ epochMilliseconds: number }[]>`
    select floor(extract(epoch from created_at) * 1000)::float8 as "epochMilliseconds" from ping where id = ${id}`
  return row.epochMilliseconds
}

const pingSources = [
  { source: "created through the model", create: createThroughModel },
  { source: "stamped by the database clock", create: insertWithDatabaseClock },
]

afterAll(async () => {
  await deletePingsByPayload("runId", [runMarker.runId])
})

describe("database client timezone", () => {
  test("runs every session in UTC, whatever the server's own timezone", async () => {
    const [setting] = await database.$queryRaw<{ timezone: string }[]>`select current_setting('TimeZone') as timezone`

    expect(setting.timezone).toBe("UTC")
  })

  test.each(pingSources)(
    "a ping $source reads back at the current time, exactly as Postgres stored it",
    async ({ create }) => {
      const id = await create()
      const ping = await findPingById(id)
      const createdAtMilliseconds = ping?.createdAt.getTime() ?? Number.NaN

      expect(Math.abs(createdAtMilliseconds - Date.now())).toBeLessThan(TOLERANCE_MILLISECONDS)
      expect(createdAtMilliseconds).toBe(await readStoredMilliseconds(id))
    },
  )

  test.each(pingSources)("a createdAt range around now finds a ping $source", async ({ create }) => {
    const id = await create()
    const now = Date.now()
    const { pings } = await listPings({
      page: 1,
      pageSize: 100,
      from: new Date(now - TOLERANCE_MILLISECONDS),
      to: new Date(now + TOLERANCE_MILLISECONDS),
    })

    expect(pings.map((ping) => ping.id)).toContain(id)
  })
})
