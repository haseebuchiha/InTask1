import { Chat } from "@ai-sdk/react"
import { DefaultChatTransport, generateId } from "ai"
import { useState } from "react"
import type { ChatMessage, ChatSessionSummary, LoadedChatSession } from "@/lib/chat-request"

const SESSION_STORAGE_KEY = "chat-session-id"

const CHAT_API_PATH = "/api/chat"

const SESSIONS_API_PATH = "/api/chat/sessions"

const SESSION_START_FAILED_MESSAGE = "Could not start a chat session. Try again."

export type ChatConversation = { key: string; sessionId: string | null; title: string | null; chat: Chat<ChatMessage> }

export type RecentChatSessions = ChatSessionSummary[] | "loading" | "failed"

type ConversationState = ChatConversation | "loading" | null

type ConversationDraft = { sessionId: string | null; title: string | null; messages: ChatMessage[] }

const EMPTY_DRAFT: ConversationDraft = { sessionId: null, title: null, messages: [] }

type SessionStartedListener = (conversationKey: string, sessionId: string) => void

type PendingSessionId = { request: Promise<string> | null }

export const useChatConversation = () => {
  const [conversation, setConversation] = useState<ConversationState>(null)
  const markSessionStarted: SessionStartedListener = (conversationKey, sessionId) => {
    storeSessionId(sessionId)
    setConversation((current) => keepStartedSession(current, conversationKey, sessionId))
  }
  const showDraft = (draft: ConversationDraft) => setConversation(buildConversation(draft, markSessionStarted))
  const openSession = async (sessionId: string) => {
    setConversation("loading")
    storeSessionId(sessionId)
    showDraft(await loadConversationDraft(sessionId))
  }
  const openStoredConversation = () => {
    if (conversation !== null) return
    const storedSessionId = readStoredSessionId()
    return storedSessionId === null ? showDraft(EMPTY_DRAFT) : openSession(storedSessionId)
  }
  const startNewConversation = () => {
    clearStoredSessionId()
    showDraft(EMPTY_DRAFT)
  }
  const shownConversation = conversation === "loading" ? null : conversation
  return { conversation: shownConversation, openStoredConversation, openSession, startNewConversation }
}

export const useRecentChatSessions = () => {
  const [recentSessions, setRecentSessions] = useState<RecentChatSessions>("loading")
  const loadRecentSessions = async () => {
    setRecentSessions("loading")
    setRecentSessions(await fetchRecentSessions().catch((): RecentChatSessions => "failed"))
  }
  return { recentSessions, loadRecentSessions }
}

const keepStartedSession = (
  current: ChatConversation | "loading" | null,
  conversationKey: string,
  sessionId: string,
) => (isConversation(current) && current.key === conversationKey ? { ...current, sessionId } : current)

const isConversation = (current: ConversationState): current is ChatConversation =>
  typeof current === "object" && current !== null

const buildConversation = (
  { sessionId, title, messages }: ConversationDraft,
  onSessionStarted: SessionStartedListener,
): ChatConversation => {
  const key = sessionId ?? `new-${generateId()}`
  const resolveSessionId = createSessionIdResolver(sessionId, (startedId) => onSessionStarted(key, startedId))
  const chat = new Chat<ChatMessage>({ id: key, messages, transport: buildChatTransport(resolveSessionId) })
  return { key, sessionId, title, chat }
}

const buildChatTransport = (resolveSessionId: () => Promise<string>) =>
  new DefaultChatTransport<ChatMessage>({
    api: CHAT_API_PATH,
    prepareSendMessagesRequest: async ({ messages }) => ({ body: { id: await resolveSessionId(), messages } }),
  })

const createSessionIdResolver = (sessionId: string | null, onStarted: (startedId: string) => void) => {
  const pending: PendingSessionId = { request: sessionId === null ? null : Promise.resolve(sessionId) }
  const forgetFailedRequest = (error: unknown): never => {
    pending.request = null
    throw error
  }
  const startSession = async () => {
    const startedId = await requestNewSessionId()
    onStarted(startedId)
    return startedId
  }
  return () => (pending.request ??= startSession().catch(forgetFailedRequest))
}

const requestNewSessionId = async () => {
  const response = await fetch(SESSIONS_API_PATH, { method: "POST" })
  if (!response.ok) throw new Error(SESSION_START_FAILED_MESSAGE)
  const session = (await response.json()) as ChatSessionSummary
  return session.id
}

const loadConversationDraft = async (sessionId: string) => {
  const loaded = await fetchChatSession(sessionId).catch(() => null)
  return loaded === null ? EMPTY_DRAFT : toConversationDraft(loaded)
}

const fetchChatSession = async (sessionId: string): Promise<LoadedChatSession | null> => {
  const response = await fetch(`${SESSIONS_API_PATH}/${encodeURIComponent(sessionId)}`)
  if (response.status === 404) clearStoredSessionId()
  return response.ok ? response.json() : null
}

const toConversationDraft = ({ session, messages }: LoadedChatSession): ConversationDraft => ({
  sessionId: session.id,
  title: session.title,
  messages,
})

const fetchRecentSessions = async (): Promise<RecentChatSessions> => {
  const response = await fetch(SESSIONS_API_PATH)
  if (!response.ok) return "failed"
  const { sessions } = (await response.json()) as { sessions: ChatSessionSummary[] }
  return sessions
}

const readStoredSessionId = () => {
  try {
    return window.localStorage.getItem(SESSION_STORAGE_KEY)
  } catch {
    return null
  }
}

const storeSessionId = (sessionId: string) =>
  updateStorage((storage) => storage.setItem(SESSION_STORAGE_KEY, sessionId))

const clearStoredSessionId = () => updateStorage((storage) => storage.removeItem(SESSION_STORAGE_KEY))

const updateStorage = (update: (storage: Storage) => void) => {
  try {
    update(window.localStorage)
    return true
  } catch {
    return false
  }
}
