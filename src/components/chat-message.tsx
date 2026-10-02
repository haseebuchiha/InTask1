import type { ToolUIPart } from "ai"
import { Streamdown } from "streamdown"
import { Loader } from "@/components/ai-elements/loader"
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool"
import { formatCachedTokens } from "@/components/ping-formatting"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Message, MessageContent, MessageFooter } from "@/components/ui/message"
import type { ChatAnswerMetadata, ChatMessage as ChatUIMessage } from "@/lib/chat-request"

type AnswerUsage = ChatAnswerMetadata["usage"]

type MessagePart = ChatUIMessage["parts"][number]

type ChatMessageProps = { message: ChatUIMessage; isAnswering?: boolean }

export const ChatMessage = ({ message, isAnswering = false }: ChatMessageProps) => {
  const isUser = message.role === "user"
  const usageLine = isUser ? "" : describeUsage(message.metadata)
  return (
    <Message align={isUser ? "end" : "start"}>
      <MessageContent>
        {message.parts.map((part, index) => (
          <ChatMessagePart key={`${message.id}-${index}`} part={part} isUser={isUser} />
        ))}
        {isAnswering && !showsProgress(message.parts.at(-1)) && <ThinkingLine />}
        {usageLine !== "" && <MessageFooter>{usageLine}</MessageFooter>}
      </MessageContent>
    </Message>
  )
}

export const PendingAnswer = () => (
  <Message align="start">
    <MessageContent>
      <ThinkingLine />
    </MessageContent>
  </Message>
)

const ChatMessagePart = ({ part, isUser }: { part: MessagePart; isUser: boolean }) => {
  if (part.type === "text") return <TextBubble text={part.text} isUser={isUser} />
  if (isQueryDatabasePart(part)) return <QueryDatabaseTool part={part} />
  return null
}

const TextBubble = ({ text, isUser }: { text: string; isUser: boolean }) => (
  <Bubble variant={isUser ? "default" : "muted"} align={isUser ? "end" : "start"}>
    <BubbleContent>
      <Streamdown>{text}</Streamdown>
    </BubbleContent>
  </Bubble>
)

const QueryDatabaseTool = ({ part }: { part: ToolUIPart }) => (
  <Tool>
    <ToolHeader title={describeQuery(part.input)} type={part.type} state={part.state} />
    <ToolContent>
      <ToolInput input={part.input} />
      <ToolOutput output={part.output} errorText={part.errorText} />
    </ToolContent>
  </Tool>
)

const ThinkingLine = () => (
  <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
    <Loader />
    Thinking…
  </div>
)

const isQueryDatabasePart = (part: MessagePart): part is ToolUIPart => part.type === "tool-queryDatabase"

const showsProgress = (part?: MessagePart) => part !== undefined && (part.type === "text" || isRunningQuery(part))

const isRunningQuery = (part: MessagePart) => isQueryDatabasePart(part) && runningQueryStates.has(part.state)

const describeQuery = (input: unknown) => queryTitles.get(readQueriedTable(input)) ?? "Queried the database"

const readQueriedTable = (input: unknown) => (input as { table?: string } | undefined)?.table ?? ""

const describeUsage = (metadata?: ChatAnswerMetadata) =>
  metadata === undefined
    ? ""
    : [formatTokenCount(metadata.usage), metadata.cached ? "from cache" : ""].filter(Boolean).join(", ")

const formatTokenCount = (usage: AnswerUsage) =>
  `${tokenCountFormat.format(usage.inputTokens + usage.outputTokens)} tokens${formatCachedTokens(usage.cachedInputTokens)}`

const runningQueryStates = new Set<ToolUIPart["state"]>(["input-streaming", "input-available"])

const queryTitles = new Map([
  ["ping", "Queried pings"],
  ["incident", "Queried incidents"],
])

const tokenCountFormat = new Intl.NumberFormat("en-US")
