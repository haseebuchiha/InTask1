"use client"

import { HistoryIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { type RecentChatSessions, useRecentChatSessions } from "@/hooks/use-chat-conversation"

type ChatHistoryMenuProps = { currentSessionId: string | null; onPick: (sessionId: string) => void }

type RecentSessionItemsProps = ChatHistoryMenuProps & { recentSessions: RecentChatSessions }

export const ChatHistoryMenu = ({ currentSessionId, onPick }: ChatHistoryMenuProps) => {
  const { recentSessions, loadRecentSessions } = useRecentChatSessions()
  const loadWhenOpened = (isOpen: boolean) => {
    if (isOpen) void loadRecentSessions()
  }
  return (
    <DropdownMenu onOpenChange={loadWhenOpened}>
      <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label="Recent chats" />}>
        <HistoryIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Recent chats</DropdownMenuLabel>
          <RecentSessionItems recentSessions={recentSessions} currentSessionId={currentSessionId} onPick={onPick} />
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const RecentSessionItems = ({ recentSessions, currentSessionId, onPick }: RecentSessionItemsProps) => {
  if (recentSessions === "loading") return <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
  if (recentSessions === "failed") return <DropdownMenuItem disabled>Could not load recent chats.</DropdownMenuItem>
  if (recentSessions.length === 0) return <DropdownMenuItem disabled>No chats yet.</DropdownMenuItem>
  return (
    <DropdownMenuRadioGroup value={currentSessionId} onValueChange={onPick}>
      {recentSessions.map((session) => (
        <DropdownMenuRadioItem key={session.id} value={session.id} closeOnClick>
          <span className="truncate">{session.title ?? "Untitled chat"}</span>
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  )
}
