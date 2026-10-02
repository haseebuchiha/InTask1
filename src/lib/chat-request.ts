import { safeValidateUIMessages, type UIMessage } from "ai"
import * as zod from "zod"

export type ChatAnswerMetadata = {
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number }
  cached?: true
}

export type ChatMessage = UIMessage<ChatAnswerMetadata>

export type ChatRequest = { sessionId: string; messages: ChatMessage[] }

export type ChatSessionSummary = { id: string; title: string | null; createdAt: string }

export type LoadedChatSession = { session: ChatSessionSummary; messages: ChatMessage[] }

export const parseChatRequest = async (body: unknown): Promise<ChatRequest | null> => {
  const envelope = chatRequestSchema.safeParse(body)
  if (!envelope.success) return null
  const messages = await readQuestionMessages(envelope.data.messages)
  return messages === null ? null : { sessionId: envelope.data.id, messages }
}

const readQuestionMessages = async (messages: unknown[]) => {
  const validation = await safeValidateUIMessages<ChatMessage>({ messages })
  return validation.success && endsWithQuestion(validation.data) ? validation.data : null
}

const endsWithQuestion = (messages: ChatMessage[]) => messages.at(-1)?.role === "user"

const chatRequestSchema = zod.object({ id: zod.string().min(1), messages: zod.array(zod.unknown()).min(1) })
