import { database } from "@/db/client"

const payloadMatchesAny = (field: string, values: string[]) => ({
  OR: values.map((value) => ({ payload: { path: [field], equals: value } })),
})

export const deletePingsByPayload = (field: string, values: string[]) =>
  database.ping.deleteMany({ where: payloadMatchesAny(field, values) })

export const deleteIncidentsByPingIds = (pingIds: number[]) =>
  database.incident.deleteMany({ where: { pingId: { in: pingIds } } })

export const deleteIncidentsByPingPayload = (field: string, values: string[]) =>
  database.incident.deleteMany({ where: { ping: payloadMatchesAny(field, values) } })

export const deleteChatSessionsByIds = async (ids: string[]) => {
  await database.message.deleteMany({ where: { sessionId: { in: ids } } })
  return database.chatSession.deleteMany({ where: { id: { in: ids } } })
}

export const deleteResponseSummariesByDays = (days: Date[]) =>
  database.responseSummary.deleteMany({ where: { day: { in: days } } })
