import "server-only"
import { createGateway } from "@ai-sdk/gateway"
import { createOpenAI, type OpenAILanguageModelResponsesOptions } from "@ai-sdk/openai"
import {
  convertToModelMessages,
  generateText,
  isStepCount,
  type LanguageModelUsage,
  type ModelMessage,
  Output,
  streamText,
  type ToolSet,
  type UIMessage,
} from "ai"
import { countTokens } from "gpt-tokenizer"
import type * as zod from "zod"
import { AI_GATEWAY_API_KEY, LLM_API_KEY, LLM_BASE_URL, LLM_CALLS_PER_HOUR, LLM_MODEL } from "@/config/env"
import { logger } from "@/config/logger"
import { countWrittenIncidentsSince, findOldestWrittenIncidentSince, sumIncidentTokensSince } from "@/models/incident"
import {
  countChargedAssistantMessagesSince,
  findOldestChargedAssistantMessageSince,
  sumMessageTokensSince,
} from "@/models/message"
import {
  countChargedResponseSummariesSince,
  findOldestChargedResponseSummarySince,
  sumResponseSummaryTokensSince,
} from "@/models/response-summary"

const PROMPT_TOKEN_LIMIT = 6000

const REQUEST_TIMEOUT_MS = 20_000

const ANSWER_TIMEOUT_MS = 60_000

const ANSWER_STEP_LIMIT = 4

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000

const TOKENS_PER_MILLION = 1_000_000

const USD_PER_MILLION_TOKENS: Record<string, ModelPrice> = {
  "gpt-5.5": { inputUsd: 5, cachedInputUsd: 0.5, outputUsd: 30 },
  default: { inputUsd: 1.25, cachedInputUsd: 0.125, outputUsd: 10 },
}

const PROXY_OPENAI_OPTIONS = { store: false } satisfies OpenAILanguageModelResponsesOptions

const GATEWAY_OPENAI_OPTIONS = {
  store: false,
  promptCacheRetention: "24h",
} satisfies OpenAILanguageModelResponsesOptions

type StructuredRequest<Schema extends zod.ZodType> = {
  schema: Schema
  instructions: string
  prompt: string
  promptCacheKey: string
}

type AnswerRequest<Tools extends ToolSet> = {
  instructions: string
  messages: UIMessage[]
  tools: Tools
  promptCacheKey: string
}

type TokenUsage = { inputTokens: number; cachedInputTokens: number; outputTokens: number }

type PricedTokens = { inputTokens: number; cachedInputTokens?: number; outputTokens: number }

type TimeWindow = { start: Date; end: Date }

type ModelPrice = { inputUsd: number; cachedInputUsd: number; outputUsd: number }

type ModelProvider = ReturnType<typeof buildProxyProvider> | ReturnType<typeof buildGatewayProvider>

export const generateStructured = async <Schema extends zod.ZodType>(request: StructuredRequest<Schema>) => {
  refuseLongPrompt(request)
  await refuseWithoutBudget()
  const generation = await requestStructuredOutput(request)
  return { output: generation.output, usage: toTokenUsage(generation.usage) }
}

const refuseLongPrompt = ({ instructions, prompt }: { instructions: string; prompt: string }) => {
  if (countPromptTokens(instructions) + countPromptTokens(prompt) > PROMPT_TOKEN_LIMIT)
    throw new Error("prompt too long")
}

const refuseWithoutBudget = async () => {
  if (!(await hasLlmBudget())) throw new Error("llm budget spent")
}

const requestStructuredOutput = <Schema extends zod.ZodType>({
  schema,
  instructions,
  prompt,
  promptCacheKey,
}: StructuredRequest<Schema>) =>
  generateText({
    model: languageModel,
    instructions,
    prompt,
    output: Output.object<zod.infer<Schema>>({ schema }),
    abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    maxRetries: 0,
    providerOptions: buildProviderOptions(promptCacheKey),
  })

const buildProviderOptions = (promptCacheKey: string) => ({
  openai: { ...modelProvider.openaiOptions, promptCacheKey },
})

export const streamAnswer = async <Tools extends ToolSet>(request: AnswerRequest<Tools>) => {
  refuseLongPrompt({ instructions: request.instructions, prompt: collectMessageText(request.messages) })
  await refuseWithoutBudget()
  return requestStreamedAnswer(
    request,
    await convertToModelMessages(request.messages, { ignoreIncompleteToolCalls: true }),
  )
}

const collectMessageText = (messages: UIMessage[]) =>
  messages
    .flatMap((message) => message.parts)
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")

const requestStreamedAnswer = <Tools extends ToolSet>(
  { instructions, tools, promptCacheKey }: AnswerRequest<Tools>,
  messages: ModelMessage[],
) =>
  streamText({
    model: languageModel,
    instructions,
    messages,
    tools,
    stopWhen: isStepCount(ANSWER_STEP_LIMIT),
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
    providerOptions: buildProviderOptions(promptCacheKey),
    onError: logStreamError,
  })

const logStreamError = ({ error }: { error: unknown }) =>
  logger.error({ err: error }, "The model's streamed answer failed")

export const toTokenUsage = (usage: LanguageModelUsage): TokenUsage => ({
  inputTokens: countOrZero(usage.inputTokens),
  cachedInputTokens: countOrZero(usage.inputTokenDetails?.cacheReadTokens),
  outputTokens: countOrZero(usage.outputTokens),
})

const countOrZero = (count: number | undefined) => count ?? 0

const countPromptTokens = (text: string) => countTokens(text, { disallowedSpecial: new Set() })

export const hasLlmBudget = async () => (await countCallsInWindow(trailingHour())) < LLM_CALLS_PER_HOUR

export const summarizeLlmUsage = async () => {
  const lastHour = trailingHour()
  const [callsThisHour, resetsAt, tokensToday] = await Promise.all([
    countCallsInWindow(lastHour),
    findBudgetResetTime(lastHour),
    sumTokensToday(lastHour.end),
  ])
  return {
    callsThisHour,
    callsPerHour: LLM_CALLS_PER_HOUR,
    resetsAt,
    estimatedUsdToday: estimateUsd(tokensToday),
    cachedInputTokensToday: tokensToday.cachedInputTokens,
  }
}

const trailingHour = (): TimeWindow => {
  const end = new Date()
  return { start: new Date(end.getTime() - MILLISECONDS_PER_HOUR), end }
}

const startOfUtcDay = (moment: Date) =>
  new Date(Date.UTC(moment.getUTCFullYear(), moment.getUTCMonth(), moment.getUTCDate()))

const countCallsInWindow = async ({ start, end }: TimeWindow) => {
  const [writtenIncidents, assistantMessages, responseSummaries] = await Promise.all([
    countWrittenIncidentsSince(start, end),
    countChargedAssistantMessagesSince(start, end),
    countChargedResponseSummariesSince(start, end),
  ])
  return writtenIncidents + assistantMessages + responseSummaries
}

const findBudgetResetTime = async ({ start, end }: TimeWindow) => {
  const oldestCallTimes = await Promise.all([
    findOldestWrittenIncidentSince(start, end).then(readCreatedAt),
    findOldestChargedAssistantMessageSince(start, end).then(readCreatedAt),
    findOldestChargedResponseSummarySince(start, end).then(readCreatedAt),
  ])
  const callTimes = oldestCallTimes.flatMap(readTime)
  return callTimes.length > 0 ? new Date(Math.min(...callTimes) + MILLISECONDS_PER_HOUR) : end
}

const readCreatedAt = (call: { createdAt: Date } | null) => call?.createdAt

const readTime = (moment: Date | undefined) => (moment ? [moment.getTime()] : [])

const sumTokensToday = async (end: Date) => {
  const start = startOfUtcDay(end)
  const tokenUsages = await Promise.all([
    sumIncidentTokensSince(start, end),
    sumMessageTokensSince(start, end),
    sumResponseSummaryTokensSince(start, end),
  ])
  return tokenUsages.reduce(addTokenUsage)
}

const addTokenUsage = (first: TokenUsage, second: TokenUsage): TokenUsage => ({
  inputTokens: first.inputTokens + second.inputTokens,
  cachedInputTokens: first.cachedInputTokens + second.cachedInputTokens,
  outputTokens: first.outputTokens + second.outputTokens,
})

export const estimateUsd = (
  { inputTokens, cachedInputTokens = 0, outputTokens }: PricedTokens,
  modelId = LLM_MODEL,
) => {
  const price = findModelPrice(modelId)
  const uncachedInputUsd = (inputTokens - cachedInputTokens) * price.inputUsd
  return (
    (uncachedInputUsd + cachedInputTokens * price.cachedInputUsd + outputTokens * price.outputUsd) / TOKENS_PER_MILLION
  )
}

const findModelPrice = (modelId: string) => USD_PER_MILLION_TOKENS[modelId] ?? USD_PER_MILLION_TOKENS.default

const buildModelProvider = () => (AI_GATEWAY_API_KEY === "" ? buildProxyProvider() : buildGatewayProvider())

const buildProxyProvider = () => ({
  languageModel: createOpenAI({ baseURL: LLM_BASE_URL, apiKey: LLM_API_KEY }).responses(LLM_MODEL),
  openaiOptions: PROXY_OPENAI_OPTIONS,
  announcement: { provider: "openai-compatible", baseURL: LLM_BASE_URL, model: LLM_MODEL },
})

const buildGatewayProvider = () => ({
  languageModel: createGateway({ apiKey: AI_GATEWAY_API_KEY })(`openai/${LLM_MODEL}`),
  openaiOptions: GATEWAY_OPENAI_OPTIONS,
  announcement: { provider: "ai-gateway", model: `openai/${LLM_MODEL}` },
})

const announceModelProvider = (provider: ModelProvider) => {
  logger.info(provider.announcement, "Model calls use this provider")
  return provider
}

const modelProvider = announceModelProvider(buildModelProvider())

const languageModel = modelProvider.languageModel
