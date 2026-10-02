import "server-only"
import { database } from "@/db/client"
import type { Prisma } from "@/db/generated/client"
import type { IncidentChatQuery } from "@/lib/chat-query"

type IncidentQueryRunners = {
  [Method in IncidentChatQuery["method"]]: (
    queryArguments: Extract<IncidentChatQuery, { method: Method }>["arguments"],
  ) => Promise<unknown>
}

type IncidentQueryRunner = (queryArguments: IncidentChatQuery["arguments"]) => Promise<unknown>

export const createIncident = (fields: Prisma.IncidentCreateInput) => database.incident.create({ data: fields })

export const updateIncidentReport = (id: number, fields: Prisma.IncidentUpdateInput) =>
  database.incident.update({ where: { id }, data: fields })

export const listIncidents = (limit: number) =>
  database.incident.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    include: { ping: { select: { id: true, createdAt: true, statusCode: true, error: true } } },
  })

export const findIncidentById = (id: number) => database.incident.findUnique({ where: { id } })

export const countWrittenIncidentsSince = (since: Date, until?: Date) =>
  database.incident.count({ where: { reportStatus: "written", createdAt: { gte: since, lte: until } } })

export const findOldestWrittenIncidentSince = (since: Date, until?: Date) =>
  database.incident.findFirst({
    where: { reportStatus: "written", createdAt: { gte: since, lte: until } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  })

export const sumIncidentTokensSince = async (since: Date, until?: Date) => {
  const totals = await database.incident.aggregate({
    where: { createdAt: { gte: since, lte: until } },
    _sum: { inputTokens: true, cachedInputTokens: true, outputTokens: true },
  })
  return {
    inputTokens: sumOrZero(totals._sum.inputTokens),
    cachedInputTokens: sumOrZero(totals._sum.cachedInputTokens),
    outputTokens: sumOrZero(totals._sum.outputTokens),
  }
}

const sumOrZero = (sum: number | null) => sum ?? 0

export const queryIncidents = (query: IncidentChatQuery) =>
  (incidentQueryRunners[query.method] as IncidentQueryRunner)(query.arguments)

const incidentQueryRunners: IncidentQueryRunners = {
  findMany: (queryArguments) => database.incident.findMany(queryArguments),
  aggregate: (queryArguments) => database.incident.aggregate(queryArguments),
  groupBy: (queryArguments) => database.incident.groupBy({ ...queryArguments, orderBy: queryArguments.orderBy }),
}
