import { randomInt, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { GET as findPingRoute } from "@/app/api/pings/[id]/route"
import { GET as listPingsRoute } from "@/app/api/pings/route"
import { database } from "@/db/client"
import type { PingRow } from "@/lib/ping-row"
import { deletePingsByPayload } from "../support/database"

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000

type PingListBody = { pings: PingRow[]; totalCount: number; page: number; pageSize: number }

const testDay = new Date(Date.UTC(1901, 0, 1) + randomInt(0, 36_000) * 24 * MILLISECONDS_PER_HOUR)

const TEST_DAY_TEXT = testDay.toISOString().slice(0, 10)

const runMarker = { seeded: true, suite: "tests/api/pings", runId: randomUUID() }

const seededHours = Array.from({ length: 25 }, (_, hour) => hour)

const seededPings = new Map<number, { id: number }>()

const hourOf = (hour: number) => new Date(testDay.getTime() + hour * MILLISECONDS_PER_HOUR)

const isFailedHour = (hour: number) => hour % 5 === 0

const succeededPing = (hour: number) => ({
  statusCode: 200,
  response: { echoed: hour, origin: "203.0.113.7" },
  error: null,
  responseKind: "echo_mismatch",
  origin: "203.0.113.7",
})

const failedPing = (hour: number) => ({
  statusCode: hour % 2 === 0 ? 500 : null,
  error: `Seeded failure at hour ${hour}`,
  responseKind: hour % 2 === 0 ? "gateway_error" : "failed",
})

const buildSeedRow = (hour: number) => ({
  createdAt: hourOf(hour),
  payload: { ...runMarker, hour },
  durationMs: 100 + hour,
  ...(isFailedHour(hour) ? failedPing(hour) : succeededPing(hour)),
})

const readHour = (row: PingRow) => (new Date(row.createdAt).getTime() - testDay.getTime()) / MILLISECONDS_PER_HOUR

const descendingHours = (newestHour: number, oldestHour: number) =>
  seededHours.filter((hour) => hour >= oldestHour && hour <= newestHour).toReversed()

const requestPingList = async (query: string) => {
  const response = await listPingsRoute(new Request(`http://localhost/api/pings?${query}`))
  return { status: response.status, body: (await response.json()) as PingListBody }
}

const requestPing = async (id: string) => {
  const response = await findPingRoute(new Request(`http://localhost/api/pings/${id}`), {
    params: Promise.resolve({ id }),
  })
  return { status: response.status, body: await response.json() }
}

const END_OF_TEST_DAY = new Date(hourOf(24).getTime() - 1).toISOString()

const TEST_DAY_QUERY = `from=${TEST_DAY_TEXT}&to=${END_OF_TEST_DAY}`

beforeAll(async () => {
  const rows = await database.ping.createManyAndReturn({ data: seededHours.map(buildSeedRow) })
  rows.forEach((row, index) => seededPings.set(seededHours[index], row))
})

afterAll(async () => {
  await deletePingsByPayload("runId", [runMarker.runId])
})

describe("GET /api/pings", () => {
  test("returns a page of summary rows, newest first, with the paging details", async () => {
    const { status, body } = await requestPingList("")

    expect(status).toBe(200)
    expect(Object.keys(body).toSorted()).toStrictEqual(["page", "pageSize", "pings", "totalCount"])
    expect(body.page).toBe(1)
    expect(body.pageSize).toBe(20)
    expect(body.totalCount).toBeGreaterThanOrEqual(seededHours.length)
    expect(body.pings).toHaveLength(20)
    body.pings.forEach((row) => {
      expect(Object.keys(row).toSorted()).toStrictEqual([
        "createdAt",
        "durationMs",
        "error",
        "id",
        "origin",
        "responseKind",
        "statusCode",
      ])
      expect(new Date(row.createdAt).toISOString()).toBe(row.createdAt)
    })
    const createdAtTimes = body.pings.map((row) => new Date(row.createdAt).getTime())
    expect(createdAtTimes).toStrictEqual(createdAtTimes.toSorted((first, second) => second - first))
  })

  test("reads a bare date as midnight UTC, so a whole day needs an exact end time", async () => {
    const bareDates = await requestPingList(`from=${TEST_DAY_TEXT}&to=${TEST_DAY_TEXT}`)
    const wholeDay = await requestPingList(TEST_DAY_QUERY)

    expect(bareDates.status).toBe(200)
    expect(bareDates.body.totalCount).toBe(1)
    expect(bareDates.body.pings.map(readHour)).toStrictEqual([0])
    expect(wholeDay.status).toBe(200)
    expect(wholeDay.body.totalCount).toBe(24)
    expect(wholeDay.body.pings.map(readHour)).toStrictEqual(descendingHours(23, 4))
  })

  test("returns the next page, and an empty page past the end with the full count", async () => {
    const secondPage = await requestPingList(`${TEST_DAY_QUERY}&page=2`)
    const pastTheEnd = await requestPingList(`${TEST_DAY_QUERY}&page=3`)

    expect(secondPage.body.page).toBe(2)
    expect(secondPage.body.pings.map(readHour)).toStrictEqual(descendingHours(3, 0))
    expect(pastTheEnd.status).toBe(200)
    expect(pastTheEnd.body).toStrictEqual({ pings: [], totalCount: 24, page: 3, pageSize: 20 })
  })

  test("includes both ends of a time range, given to the second or to the millisecond", async () => {
    const startToTheSecond = hourOf(5).toISOString().replace(".000Z", "Z")
    const { body } = await requestPingList(`from=${startToTheSecond}&to=${hourOf(10).toISOString()}`)

    expect(body.totalCount).toBe(6)
    expect(body.pings.map(readHour)).toStrictEqual(descendingHours(10, 5))
  })

  test("returns only failed pings when failedOnly is true", async () => {
    const everywhere = await requestPingList("failedOnly=true")
    const onTestDay = await requestPingList(`${TEST_DAY_QUERY}&failedOnly=true`)

    expect(everywhere.status).toBe(200)
    everywhere.body.pings.forEach((row) => expect(row.error).not.toBeNull())
    expect(onTestDay.body.totalCount).toBe(5)
    expect(onTestDay.body.pings.map(readHour)).toStrictEqual([20, 15, 10, 5, 0])
    expect(onTestDay.body.pings.map((row) => row.statusCode)).toStrictEqual([500, null, 500, null, 500])
  })

  test("combines failedOnly with a time range", async () => {
    const { body } = await requestPingList(
      `from=${hourOf(5).toISOString()}&to=${hourOf(10).toISOString()}&failedOnly=true`,
    )

    expect(body.totalCount).toBe(2)
    expect(body.pings.map(readHour)).toStrictEqual([10, 5])
  })

  test("returns every ping when failedOnly is false", async () => {
    const { body } = await requestPingList(`${TEST_DAY_QUERY}&failedOnly=false`)

    expect(body.totalCount).toBe(24)
  })

  test("reads any failedOnly value other than true as false", async () => {
    const { status, body } = await requestPingList(`${TEST_DAY_QUERY}&failedOnly=maybe`)

    expect(status).toBe(200)
    expect(body.totalCount).toBe(24)
  })

  test.each([
    ["page=0", 1],
    ["page=-3", 1],
    ["page=1.5", 1],
    ["page=12abc", 12],
  ])("reads the loose page %s as page %i", async (query, page) => {
    const { status, body } = await requestPingList(query)

    expect(status).toBe(200)
    expect(body.page).toBe(page)
  })

  test.each(["page=abc", "page=", "from=notadate", "to=notadate", "to=2026-02-30"])(
    "rejects the invalid filter %s with a 400",
    async (query) => {
      const { status, body } = await requestPingList(query)

      expect(status).toBe(400)
      expect(body).toStrictEqual({
        error:
          "Invalid filters: page must be a number, and from and to must be ISO 8601 dates or date-times like 2026-09-30 or 2026-09-30T12:00:00Z",
      })
    },
  )
})

describe("GET /api/pings/:id", () => {
  test("returns a successful ping in full, with its payload and response", async () => {
    const id = seededPings.get(7)!.id
    const { status, body } = await requestPing(String(id))

    expect(status).toBe(200)
    expect(body).toStrictEqual({
      id,
      createdAt: hourOf(7).toISOString(),
      payload: { ...runMarker, hour: 7 },
      statusCode: 200,
      durationMs: 107,
      response: { echoed: 7, origin: "203.0.113.7" },
      error: null,
      responseKind: "echo_mismatch",
      origin: "203.0.113.7",
    })
  })

  test("returns a failed ping with no response", async () => {
    const { status, body } = await requestPing(String(seededPings.get(5)!.id))

    expect(status).toBe(200)
    expect(body).toMatchObject({
      statusCode: null,
      response: null,
      error: "Seeded failure at hour 5",
      responseKind: "failed",
      origin: null,
    })
  })

  test("returns 404 for an id with no ping", async () => {
    const { status, body } = await requestPing("999999999")

    expect(status).toBe(404)
    expect(body).toStrictEqual({ error: "No ping with id 999999999" })
  })

  test.each(["abc", "12abc", "-1", "0", "1.5", "Infinity", "2147483648"])(
    "rejects the invalid id %s with a 400",
    async (id) => {
      const { status, body } = await requestPing(id)

      expect(status).toBe(400)
      expect(body).toStrictEqual({ error: expect.stringContaining("Ping id must be a whole number") })
    },
  )
})
