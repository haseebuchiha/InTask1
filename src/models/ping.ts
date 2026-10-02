import "server-only"
import { database } from "@/db/client"
import type { Prisma } from "@/db/generated/client"
import type { PingChatQuery } from "@/lib/chat-query"

type PingQueryRunners = {
  [Method in PingChatQuery["method"]]: (
    queryArguments: Extract<PingChatQuery, { method: Method }>["arguments"],
  ) => Promise<unknown>
}

type PingQueryRunner = (queryArguments: PingChatQuery["arguments"]) => Promise<unknown>

export type PingPageQuery = {
  page: number
  pageSize: number
  from?: Date
  to?: Date
  onlyWithError?: boolean
}

export const createPing = (fields: Prisma.PingCreateInput) => database.ping.create({ data: fields })

export const listPings = async (query: PingPageQuery) => {
  const where = buildWhere(query)
  const [pings, totalCount] = await Promise.all([findPage(where, query), database.ping.count({ where })])
  return { pings, totalCount }
}

export const findPingById = (id: number) => database.ping.findUnique({ where: { id } })

export const averageSuccessfulDurationBetween = async (start: Date, end: Date) => {
  const totals = await database.ping.aggregate({
    where: { createdAt: { gte: start, lt: end }, error: null },
    _avg: { durationMs: true },
    _count: { _all: true },
  })
  return { averageDurationMs: totals._avg.durationMs, count: totals._count._all }
}

export const listRecentDurations = (limit: number) =>
  database.ping.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    select: { durationMs: true, error: true },
  })

export const listPingOutcomesBetween = (start: Date, end: Date) =>
  database.ping.findMany({
    where: { createdAt: { gte: start, lt: end } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { createdAt: true, statusCode: true, durationMs: true, error: true, responseKind: true, origin: true },
  })

export const queryPings = (query: PingChatQuery) => (pingQueryRunners[query.method] as PingQueryRunner)(query.arguments)

const findPage = (where: Prisma.PingWhereInput, query: PingPageQuery) =>
  database.ping.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: (query.page - 1) * query.pageSize,
    take: query.pageSize,
    omit: { payload: true, response: true },
  })

const buildWhere = (query: PingPageQuery): Prisma.PingWhereInput => ({
  createdAt: { gte: query.from, lte: query.to },
  error: query.onlyWithError ? { not: null } : undefined,
})

const pingQueryRunners: PingQueryRunners = {
  findMany: (queryArguments) => database.ping.findMany(queryArguments),
  aggregate: (queryArguments) => database.ping.aggregate(queryArguments),
  groupBy: (queryArguments) => database.ping.groupBy({ ...queryArguments, orderBy: queryArguments.orderBy }),
}
