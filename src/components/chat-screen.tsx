"use client"

import { type Chat, useChat } from "@ai-sdk/react"
import type { ChatStatus } from "ai"
import { MessageSquareIcon, RotateCcwIcon, SendIcon, SquareIcon } from "lucide-react"
import { type ChangeEvent, type FormEvent, type KeyboardEvent, useState } from "react"
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import { ChatMessage, PendingAnswer } from "@/components/chat-message"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import type { ChatMessage as ChatUIMessage } from "@/lib/chat-request"

const SUGGESTED_QUESTIONS = [
  "What were the slowest pings today?",
  "Summarize incidents in the last 24 hours",
  "How many pings failed this week?",
]

const TITLE_LENGTH = 80

const UNTITLED_CHAT = "Chat"

type ChatProps = { chat: Chat<ChatUIMessage> }

export const ChatScreen = ({ chat }: ChatProps) => {
  const { messages, status, error, sendMessage, regenerate, stop } = useChat<ChatUIMessage>({ chat })
  const isBusy = isAnswering(status)
  const sendText = (text: string) => void sendMessage({ text })
  const retryLastQuestion = () => void regenerate()
  const stopAnswer = () => void stop()
  return (
    <section aria-label="Conversation" className="flex min-h-0 flex-1 flex-col">
      <ChatConversation messages={messages} isBusy={isBusy} />
      <div className="flex flex-col gap-3 border-t p-4">
        {error !== undefined && <ChatErrorLine message={error.message} onRetry={retryLastQuestion} />}
        {messages.length === 0 && <SuggestionChips isDisabled={isBusy} onPick={sendText} />}
        <ChatComposer isBusy={isBusy} onSend={sendText} onStop={stopAnswer} />
      </div>
    </section>
  )
}

export const ChatTitle = ({ chat, title }: ChatProps & { title: string | null }) => {
  const { messages } = useChat<ChatUIMessage>({ chat })
  return title ?? readFirstQuestion(messages) ?? UNTITLED_CHAT
}

export const isAnswering = (status: ChatStatus) => status === "submitted" || status === "streaming"

const ChatConversation = ({ messages, isBusy }: { messages: ChatUIMessage[]; isBusy: boolean }) => {
  const lastMessage = messages.at(-1)
  const hasAnswerStarted = lastMessage?.role === "assistant"
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Conversation>
        <ConversationContent>
          {messages.length === 0 && <EmptyConversation />}
          {messages.map((message) => (
            <ChatMessage
              key={message.id}
              message={message}
              isAnswering={isBusy && hasAnswerStarted && message === lastMessage}
            />
          ))}
          {isBusy && !hasAnswerStarted && <PendingAnswer />}
        </ConversationContent>
        <ConversationScrollButton aria-label="Scroll to the newest message" />
      </Conversation>
    </div>
  )
}

const readFirstQuestion = (messages: ChatUIMessage[]) =>
  messages
    .find((message) => message.role === "user")
    ?.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n\n")
    .trim()
    .slice(0, TITLE_LENGTH)

const EmptyConversation = () => (
  <ConversationEmptyState
    icon={<MessageSquareIcon />}
    title="No questions yet"
    description="Ask about response times, failures or incidents, or pick a suggestion below."
  />
)

const ChatErrorLine = ({ message, onRetry }: { message: string; onRetry: () => void }) => (
  <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
    <p className="wrap-break-word">{message}</p>
    <Button type="button" variant="outline" size="sm" onClick={onRetry}>
      <RotateCcwIcon data-icon="inline-start" />
      Retry
    </Button>
  </div>
)

const SuggestionChips = ({ isDisabled, onPick }: { isDisabled: boolean; onPick: (text: string) => void }) => (
  <ul aria-label="Suggested questions" className="flex flex-wrap gap-2">
    {SUGGESTED_QUESTIONS.map((question) => (
      <li key={question}>
        <SuggestionChip question={question} isDisabled={isDisabled} onPick={onPick} />
      </li>
    ))}
  </ul>
)

const SuggestionChip = ({
  question,
  isDisabled,
  onPick,
}: {
  question: string
  isDisabled: boolean
  onPick: (text: string) => void
}) => {
  const pickQuestion = () => onPick(question)
  return (
    <Button type="button" variant="outline" size="sm" disabled={isDisabled} onClick={pickQuestion}>
      {question}
    </Button>
  )
}

type ChatComposerProps = { isBusy: boolean; onSend: (text: string) => void; onStop: () => void }

const ChatComposer = ({ isBusy, onSend, onStop }: ChatComposerProps) => {
  const [draft, setDraft] = useState("")
  const question = draft.trim()
  const submitDraft = () => {
    if (question === "" || isBusy) return
    onSend(question)
    setDraft("")
  }
  const sendOnEnter = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    submitDraft()
  }
  const submitForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    submitDraft()
  }
  const changeDraft = (event: ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value)
  return (
    <form aria-label="Ask a question" className="flex items-end gap-2" onSubmit={submitForm}>
      <Textarea
        aria-label="Your question"
        placeholder="Ask about pings or incidents. Enter sends, Shift+Enter adds a line."
        value={draft}
        disabled={isBusy}
        onChange={changeDraft}
        onKeyDown={sendOnEnter}
      />
      {isBusy ? (
        <Button type="button" variant="outline" onClick={onStop}>
          <SquareIcon data-icon="inline-start" />
          Stop
        </Button>
      ) : (
        <Button type="submit" disabled={question === ""}>
          <SendIcon data-icon="inline-start" />
          Send
        </Button>
      )}
    </form>
  )
}
