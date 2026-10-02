"use client"

import { type Chat, useChat } from "@ai-sdk/react"
import { Dialog as SheetPrimitive } from "@base-ui/react/dialog"
import { MessageCircleIcon, PlusIcon, XIcon } from "lucide-react"
import { useState } from "react"
import { Loader } from "@/components/ai-elements/loader"
import { ChatHistoryMenu } from "@/components/chat-history-menu"
import { ChatScreen, ChatTitle, isAnswering } from "@/components/chat-screen"
import { Button } from "@/components/ui/button"
import { Sheet, SheetClose, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { type ChatConversation, useChatConversation } from "@/hooks/use-chat-conversation"
import type { ChatMessage } from "@/lib/chat-request"

type ChatPanelHeaderProps = {
  conversation: ChatConversation | null
  onPickSession: (sessionId: string) => void
  onNewChat: () => void
}

export const ChatWidget = () => {
  const [isOpen, setIsOpen] = useState(false)
  const { conversation, openStoredConversation, openSession, startNewConversation } = useChatConversation()
  const changeOpen = (shouldOpen: boolean) => {
    setIsOpen(shouldOpen)
    if (shouldOpen) openStoredConversation()
  }
  const pickSession = (sessionId: string) => void openSession(sessionId)
  return (
    <Sheet open={isOpen} onOpenChange={changeOpen} modal={false} disablePointerDismissal>
      <ChatLauncher chat={isOpen ? null : (conversation?.chat ?? null)} />
      <SheetPrimitive.Portal>
        <SheetPrimitive.Popup className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l bg-popover text-sm text-popover-foreground shadow-lg transition duration-200 ease-in-out data-ending-style:translate-x-10 data-ending-style:opacity-0 data-starting-style:translate-x-10 data-starting-style:opacity-0 sm:max-w-md">
          <ChatPanelHeader conversation={conversation} onPickSession={pickSession} onNewChat={startNewConversation} />
          {conversation === null ? (
            <LoadingConversation />
          ) : (
            <ChatScreen key={conversation.key} chat={conversation.chat} />
          )}
        </SheetPrimitive.Popup>
      </SheetPrimitive.Portal>
    </Sheet>
  )
}

const ChatLauncher = ({ chat }: { chat: Chat<ChatMessage> | null }) => (
  <div className="fixed right-6 bottom-6 z-40 rounded-lg shadow-lg">
    <SheetTrigger render={<Button type="button" size="icon-lg" className="relative size-14" />}>
      <MessageCircleIcon className="size-6" />
      {chat === null ? <LauncherLabel isAnswerStreaming={false} /> : <ChatLauncherStatus chat={chat} />}
    </SheetTrigger>
  </div>
)

const ChatLauncherStatus = ({ chat }: { chat: Chat<ChatMessage> }) => {
  const { status } = useChat<ChatMessage>({ chat })
  return <LauncherLabel isAnswerStreaming={isAnswering(status)} />
}

const LauncherLabel = ({ isAnswerStreaming }: { isAnswerStreaming: boolean }) => (
  <>
    <span className="sr-only">{isAnswerStreaming ? "Open chat, an answer is streaming" : "Open chat"}</span>
    {isAnswerStreaming && (
      <span
        aria-hidden="true"
        className="absolute top-2.5 right-2.5 size-2.5 animate-pulse rounded-full bg-primary-foreground"
      />
    )}
  </>
)

const ChatPanelHeader = ({ conversation, onPickSession, onNewChat }: ChatPanelHeaderProps) => (
  <header className="flex items-start gap-1 border-b p-4">
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <SheetTitle>
        <span className="block truncate">
          {conversation === null ? "Chat" : <ChatTitle chat={conversation.chat} title={conversation.title} />}
        </span>
      </SheetTitle>
      <SheetDescription>Ask about pings and incidents. A language model reads the database to answer.</SheetDescription>
    </div>
    <ChatHistoryMenu currentSessionId={conversation?.sessionId ?? null} onPick={onPickSession} />
    <Button type="button" variant="ghost" size="icon-sm" aria-label="New chat" onClick={onNewChat}>
      <PlusIcon />
    </Button>
    <SheetClose render={<Button type="button" variant="ghost" size="icon-sm" aria-label="Close chat" />}>
      <XIcon />
    </SheetClose>
  </header>
)

const LoadingConversation = () => (
  <div role="status" className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
    <Loader />
    Loading the chat…
  </div>
)
