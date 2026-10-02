import { randomInt } from "node:crypto"
import { afterAll, describe, expect, test } from "vitest"
import { database } from "@/db/client"
import {
  countChargedResponseSummariesSince,
  findNewestResponseSummary,
  findOldestChargedResponseSummarySince,
  findResponseSummaryByDay,
  saveResponseSummary,
  sumResponseSummaryTokensSince,
  updateResponseSummary,
} from "@/models/response-summary"
import { deleteResponseSummariesByDays } from "../support/database"

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000

const MILLISECONDS_PER_DAY = 24 * MILLISECONDS_PER_HOUR

const STATISTICS = { totalPings: 288, failedPings: 0 }

const windowStart = new Date(Date.UTC(2200, 0, 1) + randomInt(0, 3600) * MILLISECONDS_PER_DAY)

const seededDays: Date[] = []

const dayOf = (day: number) => new Date(windowStart.getTime() + day * MILLISECONDS_PER_DAY)

const hourOf = (hour: number) => new Date(windowStart.getTime() + hour * MILLISECONDS_PER_HOUR)

const pendingFields = { status: "pending", statistics: STATISTICS }

const seedSummary = async (day: number, createdHour: number, tokens: number) => {
  seededDays.push(dayOf(day))
  return database.responseSummary.create({
    data: {
      ...pendingFields,
      day: dayOf(day),
      createdAt: hourOf(createdHour),
      status: tokens > 0 ? "written" : "skipped_budget",
      inputTokens: tokens,
      cachedInputTokens: tokens / 2,
      outputTokens: tokens * 2,
    },
  })
}

afterAll(async () => {
  await deleteResponseSummariesByDays(seededDays)
})

describe("saveResponseSummary", () => {
  test("creates the day's row the first time, and replaces its fields the next time", async () => {
    seededDays.push(dayOf(1))

    const created = await saveResponseSummary(dayOf(1), pendingFields)
    const replaced = await saveResponseSummary(dayOf(1), {
      status: "written",
      summary: "All pings succeeded.",
      findings: ["No failures"],
      statistics: { totalPings: 12 },
      inputTokens: 300,
      outputTokens: 80,
    })

    expect(created).toMatchObject({ day: dayOf(1), status: "pending", statistics: STATISTICS })
    expect(replaced).toMatchObject({
      id: created.id,
      day: dayOf(1),
      status: "written",
      summary: "All pings succeeded.",
      findings: ["No failures"],
      statistics: { totalPings: 12 },
      inputTokens: 300,
      outputTokens: 80,
    })
    expect(await findResponseSummaryByDay(dayOf(1))).toStrictEqual(replaced)
  })
})

describe("saveResponseSummary: replacing a written day", () => {
  test("clears the earlier report and its tokens when the new fields leave them out", async () => {
    seededDays.push(dayOf(3))
    await saveResponseSummary(dayOf(3), {
      ...pendingFields,
      status: "written",
      summary: "All pings succeeded.",
      findings: ["No failures"],
      inputTokens: 300,
      outputTokens: 80,
    })

    const pendingAgain = await saveResponseSummary(dayOf(3), pendingFields)

    expect(pendingAgain).toMatchObject({
      status: "pending",
      summary: null,
      findings: null,
      inputTokens: 0,
      outputTokens: 0,
    })
  })
})

describe("updateResponseSummary", () => {
  test("changes the given fields of one row", async () => {
    seededDays.push(dayOf(2))
    const pending = await saveResponseSummary(dayOf(2), pendingFields)

    const failed = await updateResponseSummary(pending.id, { status: "failed" })

    expect(failed).toStrictEqual({ ...pending, status: "failed", updatedAt: failed.updatedAt })
  })
})

describe("findResponseSummaryByDay", () => {
  test("returns null for a day with no summary", async () => {
    expect(await findResponseSummaryByDay(dayOf(9))).toBeNull()
  })
})

describe("findNewestResponseSummary", () => {
  test("returns a summary at least as new as the newest day seeded", async () => {
    await seedSummary(4, 100, 0)
    await seedSummary(5, 124, 0)

    expect((await findNewestResponseSummary())!.day.getTime()).toBeGreaterThanOrEqual(dayOf(5).getTime())
  })
})

describe("charged summaries", () => {
  test("count summaries that used tokens and were made inside the window, edges included", async () => {
    await seedSummary(6, 200, 10)
    await seedSummary(7, 201, 20)
    await seedSummary(8, 202, 0)
    await seedSummary(10, 199, 40)
    await seedSummary(11, 203, 50)

    expect(await countChargedResponseSummariesSince(hourOf(200), hourOf(202))).toBe(2)
    expect(await countChargedResponseSummariesSince(hourOf(199), hourOf(203))).toBe(4)
  })

  test("find the oldest charged summary inside the window by when it was made", async () => {
    expect(await findOldestChargedResponseSummarySince(hourOf(200), hourOf(203))).toStrictEqual({
      createdAt: hourOf(200),
    })
    expect(await findOldestChargedResponseSummarySince(hourOf(204), hourOf(300))).toBeNull()
  })

  test("sum the tokens of the summaries made inside the window", async () => {
    expect(await sumResponseSummaryTokensSince(hourOf(200), hourOf(203))).toStrictEqual({
      inputTokens: 80,
      cachedInputTokens: 40,
      outputTokens: 160,
    })
    expect(await sumResponseSummaryTokensSince(hourOf(204), hourOf(300))).toStrictEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    })
  })
})
