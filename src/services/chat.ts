import "server-only"
import { createHash } from "node:crypto"
import {
  consumeStream,
  createIdGenerator,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type FinishReason,
  generateId,
  type TextStreamPart,
  type ToolSet,
  tool,
  toUIMessageStream,
  type UIMessageChunk,
  type UIMessageStreamWriter,
} from "ai"
import * as zod from "zod"
import { LLM_MODEL, PING_INTERVAL_MS } from "@/config/env"
import { logger } from "@/config/logger"
import type { Message, Prisma } from "@/db/generated/client"
import { type ChatQuery, chatQuerySchema } from "@/lib/chat-query"
import type { ChatAnswerMetadata, ChatMessage, ChatRequest } from "@/lib/chat-request"
import { createChatSession, findChatSessionById, listChatSessions, updateChatSessionTitle } from "@/models/chat-session"
import { queryIncidents } from "@/models/incident"
import { createMessages, findCachedAssistantMessage } from "@/models/message"
import { queryPings } from "@/models/ping"
import { streamAnswer, summarizeLlmUsage, toTokenUsage } from "@/services/llm"

const MILLISECONDS_PER_MINUTE = 60_000

const CACHE_LIFETIME_MS = 60 * MILLISECONDS_PER_MINUTE

const TITLE_LENGTH = 80

const RECENT_SESSION_LIMIT = 20

const TOOL_OUTPUT_CHARACTER_LIMIT = 8000

const ZERO_USAGE = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }

const MASKED_ERROR_TEXT = "An error occurred."

const CACHED_ANSWER_METADATA: ChatAnswerMetadata = { usage: ZERO_USAGE, cached: true }

const REFUSAL_METADATA: ChatAnswerMetadata = { usage: ZERO_USAGE }

const PROMPT_TOO_LONG_TEXT = "That question is too long for one call. Ask something shorter."

const CHAT_PROMPT_CACHE_KEY = "ping-monitor-chat"

const QUESTION_SEPARATOR = "\u0000"

const CHAT_INSTRUCTION_LINES = [
  `You answer questions about an uptime monitor. Every ${PING_INTERVAL_MS / MILLISECONDS_PER_MINUTE} minutes it POSTs a small random JSON payload to https://httpbin.org/anything, times the reply and saves one row in the ping table.`,
  "Every time in the database is UTC. Say UTC when you give a time.",
  "The ping table has id, createdAt, statusCode (null when no reply arrived), durationMs, error (null when the ping succeeded, the failure message when it didn't), responseKind, origin, payload (the JSON sent) and response (the JSON httpbin echoed back).",
  "responseKind is how the monitor tagged the reply: clean_echo when httpbin echoed the payload back exactly, echo_mismatch for a 2xx reply whose echo differed, empty for a 2xx reply with no JSON body, client_error for a 4xx reply, gateway_error for a 5xx reply, and failed when no reply arrived. origin is the monitor's public IP as httpbin saw it, null when the reply didn't say.",
  "The incident table has one row for each slow or failed ping: id, createdAt, pingId, severity, durationMs, averageDurationMs, reportStatus, summary, likelyCauses, recommendations, and the inputTokens and outputTokens the model used to write the report.",
  "averageDurationMs is the average of the successful pings in the 24 hours before the ping. A ping is only checked once there are at least 12 of them. It is an incident when it failed or took at least 2 times that average.",
  "severity is critical when the ping failed or took at least 5 times the average, and warning otherwise.",
  "reportStatus is written when the model wrote the report, pending while it is being written, skipped_budget when the hourly model budget was spent, and failed when writing it failed.",
  "Use the queryDatabase tool for every number you give, and never guess one. Prefer aggregate for counts, averages, minimums, maximums and totals, and groupBy for breakdowns. Use findMany only when you need individual rows.",
  "Answer in a few plain sentences, without markdown tables. When the data doesn't cover the question, say so.",
]

const QUERY_DATABASE_DESCRIPTION = [
  "Reads the monitor's database with a read-only Prisma query. table is ping or incident.",
  "method is findMany for rows, aggregate for totals over every matching row, or groupBy for totals per group. arguments holds the Prisma arguments for that method.",
  "findMany takes where, orderBy, select, skip and take (1 to 100, 20 by default).",
  "aggregate takes where, _count: true, and _avg, _sum, _min and _max as objects of numeric columns set to true. _min and _max also take createdAt.",
  "groupBy takes where, by (a list of columns), the same aggregates, orderBy (only columns listed in by) and take (which needs orderBy).",
  "where maps a column to a value, or to operators: equals, not, gt, gte, lt, lte and in for numbers and dates, and equals, not, in, contains and startsWith for text.",
  "statusCode, error, origin and summary can be null, so failed pings are where: { error: { not: null } }. AND and OR take lists of conditions, one level deep.",
  "responseKind is one of clean_echo, echo_mismatch, empty, client_error, gateway_error or failed, and takes only equals, not and in. It and origin can be grouped by, ordered by and selected like the other ping columns.",
  'orderBy is a list of one-column objects, like [{ "createdAt": "desc" }]. Dates are ISO 8601 strings in UTC, like 2026-10-01T00:00:00Z.',
  "Numeric columns: durationMs and statusCode for pings, and durationMs, averageDurationMs, inputTokens and outputTokens for incidents.",
  "payload and response on pings, and likelyCauses and recommendations on incidents, can be selected but not filtered. Pings leave them out unless select asks for them.",
  `The result is { rows } or { aggregate }, with truncated set to true when rows were dropped to fit ${TOOL_OUTPUT_CHARACTER_LIMIT} characters.`,
].join(" ")

type ChatSession = NonNullable<Awaited<ReturnType<typeof findChatSessionById>>>

type Exchange = { session: ChatSession; messages: ChatMessage[]; questionHash: string | null }

type MessageRowSource = { sessionId: string; message: ChatMessage; savedAt: number; questionHash: string | null }

type MessageParts = ChatMessage["parts"]

export const answerQuestion = async ({ sessionId, messages }: ChatRequest) => {
  const exchange = { session: await requireChatSession(sessionId), messages, questionHash: hashQuestions(messages) }
  const cachedText = await findCachedAnswerText(exchange.questionHash)
  if (cachedText !== null) return replyWithFixedAnswer(exchange, buildFixedAnswer(cachedText, CACHED_ANSWER_METADATA))
  return streamModelAnswer(exchange).catch((error: unknown) => refuseQuestion(exchange, error))
}

export const isMissingChatSessionError = (error: unknown): error is Error =>
  error instanceof Error && error.cause === missingChatSession

const requireChatSession = async (sessionId: string) => {
  const session = await findChatSessionById(sessionId)
  if (session === null) throw new Error(`No chat session with id ${sessionId}`, { cause: missingChatSession })
  return session
}

const hashQuestions = (messages: ChatMessage[]) => {
  const questions = messages.filter(isQuestion).map(normalizeQuestion)
  return createHash("sha256")
    .update(`${LLM_MODEL}\n${questions.join(QUESTION_SEPARATOR)}`)
    .digest("hex")
}

const isQuestion = (message: ChatMessage) => message.role === "user"

const normalizeQuestion = (question: ChatMessage) => readText(question.parts).trim().toLowerCase()

const readText = (parts: MessageParts) =>
  parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n")

const findCachedAnswerText = async (questionHash: string) => {
  const cachedMessage = await findCachedAssistantMessage(questionHash, new Date(Date.now() - CACHE_LIFETIME_MS))
  return cachedMessage === null ? null : readText(cachedMessage.parts as MessageParts)
}

const streamModelAnswer = async (exchange: Exchange) => {
  const answer = await streamAnswer({
    instructions: buildChatInstructions(new Date()),
    messages: exchange.messages,
    tools: chatTools,
    promptCacheKey: CHAT_PROMPT_CACHE_KEY,
  })
  answer.consumeStream()
  return createUIMessageStreamResponse({
    stream: toAnswerStream(answer.stream, exchange),
    consumeSseStream: consumeStream,
  })
}

const toAnswerStream = (stream: ReadableStream<TextStreamPart<typeof chatTools>>, exchange: Exchange) =>
  toUIMessageStream({
    stream,
    originalMessages: exchange.messages,
    generateMessageId,
    messageMetadata: readUsageMetadata,
    onError: describeStreamError,
    onEnd: ({ responseMessage, finishReason }) =>
      saveModelAnswer(cacheOnlyFinishedAnswer(exchange, finishReason), responseMessage),
  })

const cacheOnlyFinishedAnswer = (exchange: Exchange, finishReason?: FinishReason): Exchange =>
  finishReason === "stop" ? exchange : { ...exchange, questionHash: null }

const readUsageMetadata = ({ part }: { part: TextStreamPart<ToolSet> }): ChatAnswerMetadata | undefined =>
  part.type === "finish" ? { usage: toTokenUsage(part.totalUsage) } : undefined

const describeStreamError = (error: unknown) => (isRejectedQuery(error) ? error.message : MASKED_ERROR_TEXT)

const isRejectedQuery = (error: unknown): error is Error =>
  error instanceof Error && error.cause instanceof zod.ZodError

const saveModelAnswer = (exchange: Exchange, answer: ChatMessage) =>
  saveExchange(exchange, answer).catch((error: unknown) => logUnsavedAnswer(exchange, error))

const logUnsavedAnswer = (exchange: Exchange, error: unknown) =>
  logger.error({ err: error, sessionId: exchange.session.id }, "Chat answer was streamed but could not be saved")

const refuseQuestion = async (exchange: Exchange, error: unknown) => {
  const describeRefusal = refusalDescribers.get(readErrorMessage(error))
  if (describeRefusal === undefined) throw error
  return replyWithFixedAnswer(exchange, buildFixedAnswer(await describeRefusal(), REFUSAL_METADATA))
}

const readErrorMessage = (error: unknown) => (error instanceof Error ? error.message : "")

const describeSpentBudget = async () => {
  const { resetsAt } = await summarizeLlmUsage()
  return `The model budget for this hour is spent. It resets at ${resetsAt.toISOString().slice(11, 16)} UTC.`
}

const buildFixedAnswer = (text: string, metadata: ChatAnswerMetadata): ChatMessage => ({
  id: generateMessageId(),
  role: "assistant",
  parts: [{ type: "text", text }],
  metadata,
})

const replyWithFixedAnswer = async (exchange: Exchange, answer: ChatMessage) => {
  await saveExchange({ ...exchange, questionHash: null }, answer)
  return createUIMessageStreamResponse({
    stream: createUIMessageStream<ChatMessage>({ execute: writeFixedAnswer(answer) }),
  })
}

const writeFixedAnswer =
  (answer: ChatMessage) =>
  ({ writer }: { writer: UIMessageStreamWriter<ChatMessage> }) =>
    listFixedAnswerChunks(answer).forEach((chunk) => writer.write(chunk))

const listFixedAnswerChunks = (answer: ChatMessage): UIMessageChunk<ChatAnswerMetadata>[] => [
  { type: "start", messageId: answer.id, messageMetadata: answer.metadata },
  { type: "text-start", id: answer.id },
  { type: "text-delta", id: answer.id, delta: readText(answer.parts) },
  { type: "text-end", id: answer.id },
  { type: "finish", finishReason: "stop", messageMetadata: answer.metadata },
]

const saveExchange = async ({ session, messages, questionHash }: Exchange, answer: ChatMessage) => {
  const savedMessages = [...messages.slice(-1), ...keepAnswerWithTextOrTokens(answer)]
  const savedAt = Date.now()
  await createMessages(
    savedMessages.map((message, index) =>
      toMessageRow({ sessionId: session.id, message, savedAt: savedAt + index, questionHash }),
    ),
  )
  await titleUntitledSession({ session, messages, questionHash })
}

const keepAnswerWithTextOrTokens = (answer: ChatMessage) =>
  readText(answer.parts) === "" && readUsage(answer).inputTokens === 0 ? [] : [answer]

const toMessageRow = ({
  sessionId,
  message,
  savedAt,
  questionHash,
}: MessageRowSource): Prisma.MessageCreateManyInput => ({
  id: message.id,
  createdAt: new Date(savedAt),
  sessionId,
  role: message.role,
  parts: message.parts as Prisma.InputJsonValue,
  questionHash: message.role === "assistant" ? questionHash : null,
  ...readUsage(message),
})

const readUsage = (message: ChatMessage) =>
  message.role === "assistant" && message.metadata ? message.metadata.usage : ZERO_USAGE

const titleUntitledSession = async ({ session, messages }: Exchange) => {
  if (session.title !== null) return
  await updateChatSessionTitle(session.id, readText(messages.filter(isQuestion)[0].parts).trim().slice(0, TITLE_LENGTH))
}

export const startChatSession = () => createChatSession(generateId())

export const loadChatSession = async (id: string) => {
  const found = await findChatSessionById(id)
  return found === null ? null : toLoadedChatSession(found)
}

const toLoadedChatSession = ({ messages, ...session }: ChatSession) => ({
  session,
  messages: messages.map(toChatMessage),
})

const toChatMessage = (row: Message): ChatMessage => ({
  id: row.id,
  role: row.role as ChatMessage["role"],
  parts: row.parts as MessageParts,
  metadata: row.role === "assistant" ? { usage: readRowUsage(row) } : undefined,
})

const readRowUsage = ({ inputTokens, cachedInputTokens, outputTokens }: Message) => ({
  inputTokens,
  cachedInputTokens,
  outputTokens,
})

export const listRecentChatSessions = () => listChatSessions(RECENT_SESSION_LIMIT)

const runDatabaseQuery = async (input: unknown) => {
  const query = readChatQuery(input)
  const found: unknown = JSON.parse(JSON.stringify(await queryTable(query)))
  return query.method === "aggregate" ? { aggregate: found, truncated: false } : shapeRows(found as unknown[])
}

const readChatQuery = (input: unknown) => {
  const parsedQuery = chatQuerySchema.safeParse(input)
  if (parsedQuery.success) return parsedQuery.data
  throw new Error(`The query was rejected. ${zod.prettifyError(parsedQuery.error)}`, { cause: parsedQuery.error })
}

const queryTable = (query: ChatQuery) => (query.table === "ping" ? queryPings(query) : queryIncidents(query))

const shapeRows = (rows: unknown[]) => {
  const keptRows = dropRowsUntilTheyFit(rows)
  return { rows: keptRows, truncated: keptRows.length < rows.length }
}

const dropRowsUntilTheyFit = (rows: unknown[]): unknown[] =>
  JSON.stringify(rows).length <= TOOL_OUTPUT_CHARACTER_LIMIT ? rows : dropRowsUntilTheyFit(rows.slice(0, -1))

const buildChatInstructions = (moment: Date) =>
  [
    ...CHAT_INSTRUCTION_LINES,
    `It is now ${moment.toISOString().slice(0, 16).replace("T", " ")} UTC, so today is ${moment.toISOString().slice(0, 10)}.`,
  ].join(" ")

const missingChatSession = Symbol("missing chat session")

const refusalDescribers = new Map<string, () => Promise<string> | string>([
  ["llm budget spent", describeSpentBudget],
  ["prompt too long", () => PROMPT_TOO_LONG_TEXT],
])

const queryDatabaseInput = zod.object({
  table: zod.enum(["ping", "incident"]),
  method: zod.enum(["findMany", "aggregate", "groupBy"]),
  arguments: zod.looseObject({}).describe("The Prisma arguments for the method, as the tool description lists them"),
})

const chatTools = {
  queryDatabase: tool({
    description: QUERY_DATABASE_DESCRIPTION,
    inputSchema: queryDatabaseInput,
    execute: runDatabaseQuery,
  }),
}

const generateMessageId = createIdGenerator({ prefix: "msg", size: 16 })
