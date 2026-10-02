import { parseChatRequest } from "@/lib/chat-request"
import { answerQuestion, isMissingChatSessionError } from "@/services/chat"

const INVALID_CHAT_REQUEST_MESSAGE =
  "The body must be JSON like { id, messages }: id is a chat session id, and messages is a non-empty list of UI messages that ends with the user's question"

export const dynamic = "force-dynamic"

export const POST = async (request: Request) => {
  const chatRequest = await parseChatRequest(await request.json().catch(() => null))
  if (chatRequest === null) return Response.json({ error: INVALID_CHAT_REQUEST_MESSAGE }, { status: 400 })
  return answerQuestion(chatRequest).catch(respondToMissingSession)
}

const respondToMissingSession = (error: unknown) => {
  if (!isMissingChatSessionError(error)) throw error
  return Response.json({ error: error.message }, { status: 404 })
}
