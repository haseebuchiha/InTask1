import "server-only"
import { database } from "@/db/client"

export const createChatSession = (id: string) => database.chatSession.create({ data: { id } })

export const findChatSessionById = (id: string) =>
  database.chatSession.findUnique({ where: { id }, include: { messages: { orderBy: { createdAt: "asc" } } } })

export const listChatSessions = (limit: number) =>
  database.chatSession.findMany({ orderBy: { createdAt: "desc" }, take: limit })

export const updateChatSessionTitle = (id: string, title: string) =>
  database.chatSession.update({ where: { id }, data: { title } })
