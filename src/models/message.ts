import "server-only"
import { database } from "@/db/client"
import type { Prisma } from "@/db/generated/client"

export const createMessage = (fields: Prisma.MessageCreateInput) => database.message.create({ data: fields })

export const createMessages = (fields: Prisma.MessageCreateManyInput[]) =>
  database.message.createMany({ data: fields, skipDuplicates: true })

export const listMessagesBySession = (sessionId: string) =>
  database.message.findMany({ where: { sessionId }, orderBy: { createdAt: "asc" } })

export const countChargedAssistantMessagesSince = (since: Date, until?: Date) =>
  database.message.count({
    where: { role: "assistant", inputTokens: { gt: 0 }, createdAt: { gte: since, lte: until } },
  })

export const findOldestChargedAssistantMessageSince = (since: Date, until?: Date) =>
  database.message.findFirst({
    where: { role: "assistant", inputTokens: { gt: 0 }, createdAt: { gte: since, lte: until } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  })

export const sumMessageTokensSince = async (since: Date, until?: Date) => {
  const totals = await database.message.aggregate({
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

export const findCachedAssistantMessage = (questionHash: string, since: Date) =>
  database.message.findFirst({
    where: { role: "assistant", questionHash, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
  })
