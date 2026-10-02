import { parseChatSessionId } from "@/lib/chat-session-id"
import { loadChatSession } from "@/services/chat"

export const GET = async (_request: Request, context: RouteContext<"/api/chat/sessions/[id]">) => {
  const requestedId = (await context.params).id
  const conversation = await loadValidChatSession(requestedId)
  if (conversation === null) return Response.json({ error: `No chat session with id ${requestedId}` }, { status: 404 })
  return Response.json(conversation)
}

const loadValidChatSession = async (requestedId: string) => {
  const sessionId = parseChatSessionId(requestedId)
  return sessionId === null ? null : loadChatSession(sessionId)
}
