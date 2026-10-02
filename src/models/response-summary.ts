import "server-only"
import { database } from "@/db/client"
import { Prisma } from "@/db/generated/client"

export type ResponseSummaryFields = Omit<Prisma.ResponseSummaryCreateInput, "day">

export const saveResponseSummary = (day: Date, fields: ResponseSummaryFields) =>
  database.responseSummary.upsert({
    where: { day },
    create: { day, ...fields },
    update: {
      summary: null,
      findings: Prisma.DbNull,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      ...fields,
    },
  })

export const updateResponseSummary = (id: number, fields: Prisma.ResponseSummaryUpdateInput) =>
  database.responseSummary.update({ where: { id }, data: fields })

export const findResponseSummaryByDay = (day: Date) => database.responseSummary.findUnique({ where: { day } })

export const findNewestResponseSummary = () => database.responseSummary.findFirst({ orderBy: { day: "desc" } })

export const countChargedResponseSummariesSince = (since: Date, until?: Date) =>
  database.responseSummary.count({ where: { inputTokens: { gt: 0 }, createdAt: { gte: since, lte: until } } })

export const findOldestChargedResponseSummarySince = (since: Date, until?: Date) =>
  database.responseSummary.findFirst({
    where: { inputTokens: { gt: 0 }, createdAt: { gte: since, lte: until } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  })

export const sumResponseSummaryTokensSince = async (since: Date, until?: Date) => {
  const totals = await database.responseSummary.aggregate({
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
