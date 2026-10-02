import { describe, expect, test } from "vitest"
import { chatQuerySchema, describeChatQuery } from "@/lib/chat-query"

const DEFAULT_PING_SELECT = {
  id: true,
  createdAt: true,
  statusCode: true,
  durationMs: true,
  error: true,
  responseKind: true,
  origin: true,
}

const pingQuery = (method: string, queryArguments: Record<string, unknown>) => ({
  table: "ping",
  method,
  arguments: queryArguments,
})

const incidentQuery = (method: string, queryArguments: Record<string, unknown>) => ({
  table: "incident",
  method,
  arguments: queryArguments,
})

const readIssues = (query: unknown) => chatQuerySchema.safeParse(query).error?.issues

describe("chatQuerySchema: accepted queries", () => {
  test("reads a ping findMany, turning dates into Date objects and leaving payload and response out by default", () => {
    const query = pingQuery("findMany", {
      where: { createdAt: { gte: "2026-10-01", lt: "2026-10-02T06:30:00Z" }, durationMs: { gt: 2000 }, error: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    })

    expect(chatQuerySchema.parse(query)).toStrictEqual({
      table: "ping",
      method: "findMany",
      arguments: {
        where: {
          createdAt: { gte: new Date("2026-10-01T00:00:00Z"), lt: new Date("2026-10-02T06:30:00Z") },
          durationMs: { gt: 2000 },
          error: null,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: DEFAULT_PING_SELECT,
        take: 20,
      },
    })
  })

  test("keeps an explicit select, skip and take, including payload and response", () => {
    const query = pingQuery("findMany", { select: { id: true, payload: true, response: true }, skip: 40, take: 100 })

    expect(chatQuerySchema.parse(query).arguments).toStrictEqual({
      select: { id: true, payload: true, response: true },
      skip: 40,
      take: 100,
    })
  })

  test("reads plain values, null, AND and OR on incidents, and selects every column when no select is given", () => {
    const query = incidentQuery("findMany", {
      where: {
        severity: "critical",
        summary: { not: null },
        AND: [{ durationMs: { gte: 500 } }, { averageDurationMs: { lte: 300 } }],
        OR: [
          { reportStatus: { in: ["failed", "skipped_budget"] } },
          { summary: { contains: "slow", startsWith: "The" } },
        ],
      },
      take: 5,
    })

    expect(chatQuerySchema.parse(query).arguments).toStrictEqual({ ...query.arguments })
  })

  test("filters, orders and selects pings by how the reply was tagged and the caller IP httpbin saw", () => {
    const query = pingQuery("findMany", {
      where: { responseKind: { in: ["gateway_error", "failed"] }, origin: { not: null } },
      orderBy: [{ responseKind: "asc" }, { origin: "desc" }],
      select: { id: true, responseKind: true, origin: true },
      take: 10,
    })

    expect(chatQuerySchema.parse(query).arguments).toStrictEqual({ ...query.arguments })
  })

  test.each([
    pingQuery("groupBy", {
      by: ["responseKind", "origin"],
      _count: true,
      orderBy: [{ responseKind: "asc" }],
      take: 12,
    }),
    pingQuery("aggregate", { where: { responseKind: "clean_echo", origin: "203.0.113.7" }, _count: true }),
    pingQuery("aggregate", {
      where: { statusCode: { not: 200 } },
      _count: true,
      _avg: { durationMs: true },
      _min: { createdAt: true },
      _max: { durationMs: true },
    }),
    incidentQuery("aggregate", { _sum: { inputTokens: true, outputTokens: true } }),
    pingQuery("groupBy", { by: ["statusCode"], _count: true, _avg: { durationMs: true } }),
    incidentQuery("groupBy", {
      where: { createdAt: { gte: "2026-09-01" } },
      by: ["severity", "reportStatus"],
      _count: true,
      orderBy: [{ severity: "asc" }],
      take: 10,
    }),
  ])("accepts the aggregate or groupBy query %#", (query) => {
    expect(chatQuerySchema.safeParse(query).success).toBe(true)
  })
})

describe("chatQuerySchema: rejected queries", () => {
  test.each([
    { name: "an unknown top-level key", query: { ...pingQuery("findMany", {}), sql: "DROP TABLE ping" } },
    { name: "an unknown argument", query: pingQuery("findMany", { include: { incidents: true } }) },
    { name: "an unknown column in where", query: pingQuery("findMany", { where: { host: "httpbin.org" } }) },
    { name: "payload in where", query: pingQuery("findMany", { where: { payload: { equals: {} } } }) },
    { name: "response in where", query: pingQuery("aggregate", { where: { response: null }, _count: true }) },
    { name: "an unknown operator", query: pingQuery("findMany", { where: { durationMs: { between: [1, 2] } } }) },
    { name: "text operators on a number", query: pingQuery("findMany", { where: { durationMs: { contains: "1" } } }) },
    { name: "null on a column that is never empty", query: pingQuery("findMany", { where: { durationMs: null } }) },
    {
      name: "a fraction on a whole-number column",
      query: pingQuery("findMany", { where: { durationMs: { gt: 1.5 } } }),
    },
    {
      name: "a time without an offset",
      query: pingQuery("findMany", { where: { createdAt: { gte: "2026-10-01T10:00:00" } } }),
    },
    { name: "a date that isn't a date", query: pingQuery("findMany", { where: { createdAt: { gte: "yesterday" } } }) },
    { name: "AND nested in AND", query: pingQuery("findMany", { where: { AND: [{ AND: [{ durationMs: 1 }] }] } }) },
    { name: "take 101", query: pingQuery("findMany", { take: 101 }) },
    { name: "take 0", query: incidentQuery("findMany", { take: 0 }) },
    { name: "a negative skip", query: pingQuery("findMany", { skip: -1 }) },
    {
      name: "two columns in one orderBy entry",
      query: pingQuery("findMany", { orderBy: [{ createdAt: "desc", id: "desc" }] }),
    },
    { name: "a select with nothing chosen", query: pingQuery("findMany", { select: { payload: false } }) },
    { name: "an incident column on pings", query: pingQuery("findMany", { select: { severity: true } }) },
    {
      name: "an aggregate with nothing to compute",
      query: pingQuery("aggregate", { where: { durationMs: { gt: 1 } } }),
    },
    { name: "an average of a text column", query: incidentQuery("aggregate", { _avg: { severity: true } }) },
    { name: "a groupBy without by", query: pingQuery("groupBy", { _count: true }) },
    { name: "a groupBy by a JSON column", query: pingQuery("groupBy", { by: ["payload"] }) },
    { name: "a groupBy take without orderBy", query: incidentQuery("groupBy", { by: ["severity"], take: 3 }) },
    {
      name: "a groupBy ordered by a column outside by",
      query: incidentQuery("groupBy", { by: ["severity"], orderBy: [{ durationMs: "desc" }] }),
    },
    { name: "a write method", query: pingQuery("deleteMany", { where: {} }) },
    { name: "an unknown table", query: { table: "message", method: "findMany", arguments: {} } },
    {
      name: "a responseKind the monitor never writes",
      query: pingQuery("findMany", { where: { responseKind: "timeout" } }),
    },
    {
      name: "text operators on responseKind",
      query: pingQuery("findMany", { where: { responseKind: { contains: "echo" } } }),
    },
    {
      name: "null on responseKind, which is never empty",
      query: pingQuery("findMany", { where: { responseKind: null } }),
    },
  ])("rejects $name", ({ query }) => {
    expect(chatQuerySchema.safeParse(query).success).toBe(false)
  })

  test("says which key it didn't expect", () => {
    expect(readIssues(pingQuery("findMany", { where: { payload: {} } }))).toStrictEqual([
      expect.objectContaining({ code: "unrecognized_keys", keys: ["payload"], path: ["arguments", "where"] }),
    ])
  })
})

describe("describeChatQuery", () => {
  test.each([
    {
      query: pingQuery("findMany", { where: { durationMs: { gt: 2000 } }, orderBy: [{ createdAt: "desc" }] }),
      description: "pings where durationMs > 2000, newest first, 20 rows",
    },
    {
      query: pingQuery("aggregate", { where: { error: { not: null } }, _count: true, _avg: { durationMs: true } }),
      description: "count, average durationMs of pings where error != null",
    },
    {
      query: pingQuery("aggregate", { _min: { createdAt: true }, _max: { createdAt: true } }),
      description: "lowest createdAt, highest createdAt of pings",
    },
    {
      query: incidentQuery("groupBy", {
        by: ["severity"],
        _count: true,
        _sum: { outputTokens: true },
        orderBy: [{ severity: "asc" }],
        take: 5,
      }),
      description: "incidents grouped by severity with count, total outputTokens, by severity ascending, 5 groups",
    },
    {
      query: incidentQuery("groupBy", { by: ["reportStatus"] }),
      description: "incidents grouped by reportStatus",
    },
    {
      query: incidentQuery("findMany", {
        where: {
          severity: "critical",
          createdAt: { gte: "2026-10-01" },
          OR: [{ reportStatus: { in: ["failed", "skipped_budget"] } }, { summary: { startsWith: "slow" } }],
        },
        orderBy: [{ durationMs: "desc" }, { createdAt: "asc" }],
        skip: 10,
        take: 5,
      }),
      description:
        'incidents where createdAt >= 2026-10-01T00:00:00.000Z and severity = "critical" and (reportStatus in ("failed", "skipped_budget") or summary starts with "slow"), by durationMs descending, oldest first, skipping 10, 5 rows',
    },
  ])("describes $description", ({ query, description }) => {
    expect(describeChatQuery(query)).toBe(description)
  })

  test("describes a query that was already parsed the same way", () => {
    const query = pingQuery("findMany", { where: { createdAt: { lt: "2026-10-01T12:00:00Z" } }, take: 3 })

    expect(describeChatQuery(chatQuerySchema.parse(query))).toBe(describeChatQuery(query))
    expect(describeChatQuery(query)).toBe("pings where createdAt < 2026-10-01T12:00:00.000Z, 3 rows")
  })

  test("says when it can't read the query", () => {
    expect(describeChatQuery({ table: "ping", method: "deleteMany", arguments: {} })).toBe(
      "a query the monitor can't read",
    )
    expect(describeChatQuery(undefined)).toBe("a query the monitor can't read")
  })
})
