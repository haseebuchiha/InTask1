import { randomInt, randomUUID } from "node:crypto"
import { APICallError, type LanguageModelUsage, NoObjectGeneratedError, tool, type UIMessage } from "ai"
import type { MockLanguageModelV4 } from "ai/test"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import * as zod from "zod"
import { LLM_API_KEY, LLM_BASE_URL, LLM_CALLS_PER_HOUR, LLM_MODEL } from "@/config/env"
import { logger } from "@/config/logger"
import { database } from "@/db/client"
import { createIncident } from "@/models/incident"
import { createMessage } from "@/models/message"
import { createPing } from "@/models/ping"
import {
  estimateUsd,
  generateStructured,
  hasLlmBudget,
  streamAnswer,
  summarizeLlmUsage,
  toTokenUsage,
} from "@/services/llm"
import {
  deleteChatSessionsByIds,
  deleteIncidentsByPingIds,
  deletePingsByPayload,
  deleteResponseSummariesByDays,
} from "../support/database"
import { modelUsage, replyInSteps, textStep, toolCallStep, withCachedInputTokens } from "../support/model-stream"

const providerSettings = vi.hoisted(() => ({ openai: [] as unknown[], gateway: [] as unknown[] }))

const builtModels = vi.hoisted(() => [] as MockLanguageModelV4[])

vi.mock("@ai-sdk/openai", async () =>
  (await import("../support/model-provider")).mockOpenAIModule(builtModels, providerSettings.openai),
)

vi.mock("@ai-sdk/gateway", async () =>
  (await import("../support/model-provider")).mockGatewayModule(builtModels, providerSettings.gateway),
)

const MILLISECONDS_PER_MINUTE = 60 * 1000

const MINUTES_PER_DAY = 24 * 60

const REPORT = { summary: "httpbin answered slowly", likelyCauses: ["network congestion", "httpbin under load"] }

const INSTRUCTIONS = "You write short incident reports."

const CACHE_KEY = "ping-monitor-test"

type ModelReply = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>

const languageModel = builtModels[0]

const now = new Date(Date.UTC(2001, 0, 1, 12) + randomInt(0, 7300) * MINUTES_PER_DAY * MILLISECONDS_PER_MINUTE)

const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * MILLISECONDS_PER_MINUTE)

const runMarker = { seeded: true, suite: "tests/services/llm", runId: randomUUID() }

const SESSION_ID = randomUUID()

const seededPingIds: number[] = []

const seedIncident = (minutes: number, reportStatus: string, tokens = 0) =>
  createIncident({
    ping: { connect: { id: seededPingIds[0] } },
    createdAt: minutesAgo(minutes),
    severity: "warning",
    durationMs: 900,
    averageDurationMs: 300,
    reportStatus,
    inputTokens: tokens,
    outputTokens: tokens * 2,
  })

const seedMessage = (minutes: number, role: string, tokens = 0) =>
  createMessage({
    id: randomUUID(),
    createdAt: minutesAgo(minutes),
    session: { connect: { id: SESSION_ID } },
    role,
    parts: [{ type: "text", text: `${role} ${minutes} minutes ago` }],
    inputTokens: tokens,
    outputTokens: tokens * 2,
  })

const seededSummaryDays: Date[] = []

const seedSummary = (minutes: number, tokens = 0) => {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - seededSummaryDays.length))
  seededSummaryDays.push(day)
  return database.responseSummary.create({
    data: {
      day,
      createdAt: minutesAgo(minutes),
      status: tokens > 0 ? "written" : "skipped_budget",
      statistics: { totalPings: 0 },
      inputTokens: tokens,
      outputTokens: tokens * 2,
    },
  })
}

const seedCalls = (count: number, minutes: number) =>
  Promise.all(
    Array.from({ length: count }, (_value, index) =>
      index % 2 === 0 ? seedIncident(minutes, "written") : seedMessage(minutes, "assistant", 1),
    ),
  )

const reportSchema = zod.object({ summary: zod.string(), likelyCauses: zod.array(zod.string()).min(2) })

const modelReply = (text: string, inputTokens?: number, outputTokens?: number): ModelReply => ({
  content: [{ type: "text", text }],
  finishReason: { unified: "stop", raw: "stop" },
  usage: modelUsage(inputTokens, outputTokens),
  warnings: [],
})

const replyWith = (text: string, inputTokens?: number, outputTokens?: number) =>
  vi.spyOn(languageModel, "doGenerate").mockResolvedValue(modelReply(text, inputTokens, outputTokens))

const wordsOfTokens = (count: number) => " word".repeat(count)

const userMessage = (text: string): UIMessage => ({ id: randomUUID(), role: "user", parts: [{ type: "text", text }] })

const lookUpTool = {
  lookUp: tool({
    description: "Looks up how many rows a table has",
    inputSchema: zod.object({ table: zod.string() }),
    execute: async ({ table }) => ({ table, rowCount: 42 }),
  }),
}

const lookUpStep = (inputTokens: number, outputTokens: number) =>
  toolCallStep({ toolName: "lookUp", input: { table: "ping" } }, inputTokens, outputTokens)

beforeAll(async () => {
  const ping = await createPing({
    createdAt: minutesAgo(2 * MINUTES_PER_DAY),
    payload: runMarker,
    durationMs: 900,
    responseKind: "failed",
  })
  seededPingIds.push(ping.id)
})

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now })
  await database.chatSession.create({ data: { id: SESSION_ID, createdAt: minutesAgo(2 * MINUTES_PER_DAY) } })
})

afterEach(async () => {
  vi.useRealTimers()
  await deleteIncidentsByPingIds(seededPingIds)
  await deleteChatSessionsByIds([SESSION_ID])
  await deleteResponseSummariesByDays(seededSummaryDays.splice(0))
})

afterAll(async () => {
  await deletePingsByPayload("runId", [runMarker.runId])
})

describe("the language model", () => {
  test("is built once, from the LLM settings, as a Responses API model, and not through the gateway without its key", () => {
    expect(providerSettings.openai).toStrictEqual([{ baseURL: LLM_BASE_URL, apiKey: LLM_API_KEY }])
    expect(providerSettings.gateway).toStrictEqual([])
    expect(builtModels).toMatchObject([{ provider: "openai.responses", modelId: LLM_MODEL }])
  })
})

describe("generateStructured", () => {
  test("sends the instructions and prompt with a JSON schema and a 20-second timeout, and returns the parsed output and usage", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout")
    const doGenerate = replyWith(JSON.stringify(REPORT), 120, 30)

    const structured = await generateStructured({
      schema: reportSchema,
      instructions: INSTRUCTIONS,
      prompt: "The ping took 900 ms.",
      promptCacheKey: CACHE_KEY,
    })

    expect(structured).toStrictEqual({
      output: REPORT,
      usage: { inputTokens: 120, cachedInputTokens: 0, outputTokens: 30 },
    })
    expect(timeoutSpy).toHaveBeenCalledExactlyOnceWith(20_000)
    expect(doGenerate).toHaveBeenCalledOnce()
    expect(doGenerate.mock.calls[0][0]).toMatchObject({
      prompt: [
        { role: "system", content: INSTRUCTIONS },
        { role: "user", content: [{ type: "text", text: "The ping took 900 ms." }] },
      ],
      responseFormat: {
        type: "json",
        schema: expect.objectContaining({ type: "object", required: ["summary", "likelyCauses"] }),
      },
      abortSignal: timeoutSpy.mock.results[0].value,
    })
    expect(doGenerate.mock.calls[0][0].providerOptions).toStrictEqual({
      openai: { store: false, promptCacheKey: CACHE_KEY },
    })
  })

  test("returns the input tokens the provider read from its prompt cache", async () => {
    vi.spyOn(languageModel, "doGenerate").mockResolvedValue({
      ...modelReply(JSON.stringify(REPORT)),
      usage: modelUsage(1300, 40, 1024),
    })

    const structured = await generateStructured({
      schema: reportSchema,
      instructions: INSTRUCTIONS,
      prompt: "The ping took 900 ms.",
      promptCacheKey: CACHE_KEY,
    })

    expect(structured.usage).toStrictEqual({ inputTokens: 1300, cachedInputTokens: 1024, outputTokens: 40 })
  })

  test("reports zero tokens when the model sends no usage", async () => {
    replyWith(JSON.stringify(REPORT))

    const structured = await generateStructured({
      schema: reportSchema,
      instructions: INSTRUCTIONS,
      prompt: "The ping took 900 ms.",
      promptCacheKey: CACHE_KEY,
    })

    expect(structured.usage).toStrictEqual({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 })
  })

  test("accepts exactly 6000 prompt tokens, counting the instructions and the prompt together", async () => {
    const doGenerate = replyWith(JSON.stringify(REPORT), 6000, 40)

    await generateStructured({
      schema: reportSchema,
      instructions: wordsOfTokens(1000),
      prompt: wordsOfTokens(5000),
      promptCacheKey: CACHE_KEY,
    })

    expect(doGenerate).toHaveBeenCalledOnce()
  })

  test("refuses a prompt over 6000 tokens without calling the model", async () => {
    const doGenerate = replyWith(JSON.stringify(REPORT), 6001, 40)

    await expect(
      generateStructured({
        schema: reportSchema,
        instructions: wordsOfTokens(1000),
        prompt: wordsOfTokens(5001),
        promptCacheKey: CACHE_KEY,
      }),
    ).rejects.toThrow(new Error("prompt too long"))

    expect(doGenerate).not.toHaveBeenCalled()
  })

  test("refuses without calling the model when the hourly budget is spent", async () => {
    await seedCalls(LLM_CALLS_PER_HOUR, 10)
    const doGenerate = replyWith(JSON.stringify(REPORT), 120, 30)

    await expect(
      generateStructured({
        schema: reportSchema,
        instructions: INSTRUCTIONS,
        prompt: "The ping took 900 ms.",
        promptCacheKey: CACHE_KEY,
      }),
    ).rejects.toThrow(new Error("llm budget spent"))

    expect(doGenerate).not.toHaveBeenCalled()
  })

  test("rejects when the model's answer doesn't match the schema", async () => {
    replyWith(JSON.stringify({ summary: 42 }), 120, 30)

    await expect(
      generateStructured({
        schema: reportSchema,
        instructions: INSTRUCTIONS,
        prompt: "The ping took 900 ms.",
        promptCacheKey: CACHE_KEY,
      }),
    ).rejects.toBeInstanceOf(NoObjectGeneratedError)
  })

  test("makes one attempt, so a retryable provider error reaches the caller without an uncounted retry", async () => {
    const overloaded = new APICallError({
      message: "upstream overloaded",
      url: LLM_BASE_URL,
      requestBodyValues: {},
      statusCode: 503,
    })
    const doGenerate = vi.spyOn(languageModel, "doGenerate").mockRejectedValue(overloaded)

    await expect(
      generateStructured({
        schema: reportSchema,
        instructions: INSTRUCTIONS,
        prompt: "The ping took 900 ms.",
        promptCacheKey: CACHE_KEY,
      }),
    ).rejects.toBe(overloaded)

    expect(overloaded.isRetryable).toBe(true)
    expect(doGenerate).toHaveBeenCalledOnce()
  })
})

describe("streamAnswer", () => {
  test("streams the answer from the instructions, the conversation and the tools, with store off and a 60-second timeout", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout")
    const doStream = replyInSteps(languageModel, [
      lookUpStep(100, 10),
      textStep("The ping table has 42 rows.", 150, 20),
    ])

    const answer = await streamAnswer({
      instructions: INSTRUCTIONS,
      messages: [userMessage("How many pings are there?")],
      tools: lookUpTool,
      promptCacheKey: CACHE_KEY,
    })

    expect(await answer.text).toBe("The ping table has 42 rows.")
    expect(await answer.totalUsage).toMatchObject({ inputTokens: 250, outputTokens: 30 })
    expect(timeoutSpy).toHaveBeenCalledExactlyOnceWith(60_000)
    expect(doStream).toHaveBeenCalledTimes(2)
    expect(doStream.mock.calls[0][0]).toMatchObject({
      prompt: [
        { role: "system", content: INSTRUCTIONS },
        { role: "user", content: [{ type: "text", text: "How many pings are there?" }] },
      ],
      tools: [expect.objectContaining({ type: "function", name: "lookUp" })],
      abortSignal: timeoutSpy.mock.results[0].value,
    })
    expect(doStream.mock.calls[0][0].providerOptions).toStrictEqual({
      openai: { store: false, promptCacheKey: CACHE_KEY },
    })
    expect(doStream.mock.calls[1][0].prompt).toContainEqual({
      role: "tool",
      content: [
        expect.objectContaining({
          type: "tool-result",
          toolName: "lookUp",
          output: { type: "json", value: { table: "ping", rowCount: 42 } },
        }),
      ],
    })
  })

  test("stops after four model steps", async () => {
    const doStream = replyInSteps(languageModel, [
      lookUpStep(10, 1),
      lookUpStep(10, 1),
      lookUpStep(10, 1),
      lookUpStep(10, 1),
      textStep("never sent"),
    ])

    const answer = await streamAnswer({
      instructions: INSTRUCTIONS,
      messages: [userMessage("Keep looking")],
      tools: lookUpTool,
      promptCacheKey: CACHE_KEY,
    })

    expect(await answer.finishReason).toBe("tool-calls")
    expect(doStream).toHaveBeenCalledTimes(4)
  })

  test("accepts exactly 6000 prompt tokens, counting the instructions and the conversation's text", async () => {
    const doStream = replyInSteps(languageModel, [textStep("Fine.", 6000, 2)])

    const answer = await streamAnswer({
      instructions: wordsOfTokens(1000),
      messages: [userMessage(wordsOfTokens(5000))],
      tools: lookUpTool,
      promptCacheKey: CACHE_KEY,
    })

    expect(await answer.text).toBe("Fine.")
    expect(doStream).toHaveBeenCalledOnce()
  })

  test("refuses a prompt over 6000 tokens without calling the model", async () => {
    const doStream = vi.spyOn(languageModel, "doStream")

    await expect(
      streamAnswer({
        instructions: wordsOfTokens(1000),
        messages: [userMessage(wordsOfTokens(5001))],
        tools: lookUpTool,
        promptCacheKey: CACHE_KEY,
      }),
    ).rejects.toThrow(new Error("prompt too long"))

    expect(doStream).not.toHaveBeenCalled()
  })

  test("adds up the text of every message, and leaves tool results out of the count", async () => {
    const earlierAnswer: UIMessage = {
      id: randomUUID(),
      role: "assistant",
      parts: [
        { type: "step-start" },
        {
          type: "tool-lookUp",
          toolCallId: "call-earlier",
          state: "output-available",
          input: { table: "ping" },
          output: { filler: wordsOfTokens(8000) },
        },
        { type: "text", text: wordsOfTokens(2999) },
      ],
    }
    const doStream = replyInSteps(languageModel, [textStep("Fine.", 3100, 2)])

    const answer = await streamAnswer({
      instructions: "Answer.",
      messages: [userMessage("Hi"), earlierAnswer, userMessage("And now?")],
      tools: lookUpTool,
      promptCacheKey: CACHE_KEY,
    })
    await answer.consumeStream()

    expect(doStream).toHaveBeenCalledOnce()
    await expect(
      streamAnswer({
        instructions: "Answer.",
        messages: [userMessage(wordsOfTokens(3000)), earlierAnswer, userMessage("And now?")],
        tools: lookUpTool,
        promptCacheKey: CACHE_KEY,
      }),
    ).rejects.toThrow(new Error("prompt too long"))
  })

  test("counts special-token text in a question as plain text and still asks the model", async () => {
    const doStream = replyInSteps(languageModel, [textStep("It marks the end of a document.", 20, 8)])

    const answer = await streamAnswer({
      instructions: INSTRUCTIONS,
      messages: [userMessage("What does <|endoftext|> mean?")],
      tools: lookUpTool,
      promptCacheKey: CACHE_KEY,
    })

    expect(await answer.text).toBe("It marks the end of a document.")
    expect(doStream).toHaveBeenCalledOnce()
  })

  test("leaves out a tool call that never got its result, like one stopped from the browser, so the follow-up still reaches the model", async () => {
    const stoppedAnswer: UIMessage = {
      id: randomUUID(),
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "tool-lookUp", toolCallId: "call-stopped", state: "input-available", input: { table: "ping" } },
      ],
    }
    const doStream = replyInSteps(languageModel, [textStep("No incidents.", 100, 2)])

    const answer = await streamAnswer({
      instructions: INSTRUCTIONS,
      messages: [userMessage("How many pings?"), stoppedAnswer, userMessage("Any incidents?")],
      tools: lookUpTool,
      promptCacheKey: CACHE_KEY,
    })

    expect(await answer.text).toBe("No incidents.")
    expect(JSON.stringify(doStream.mock.calls[0][0].prompt)).not.toContain("call-stopped")
  })

  test("refuses without calling the model when the hourly budget is spent", async () => {
    await seedCalls(LLM_CALLS_PER_HOUR, 10)
    const doStream = vi.spyOn(languageModel, "doStream")

    await expect(
      streamAnswer({
        instructions: INSTRUCTIONS,
        messages: [userMessage("How many pings are there?")],
        tools: lookUpTool,
        promptCacheKey: CACHE_KEY,
      }),
    ).rejects.toThrow(new Error("llm budget spent"))

    expect(doStream).not.toHaveBeenCalled()
  })

  test("makes one attempt and logs a failed stream", async () => {
    const overloaded = new APICallError({
      message: "upstream overloaded",
      url: LLM_BASE_URL,
      requestBodyValues: {},
      statusCode: 503,
    })
    const doStream = vi.spyOn(languageModel, "doStream").mockRejectedValue(overloaded)
    const errorLog = vi.spyOn(logger, "error")

    const answer = await streamAnswer({
      instructions: INSTRUCTIONS,
      messages: [userMessage("How many pings are there?")],
      tools: lookUpTool,
      promptCacheKey: CACHE_KEY,
    })
    await answer.consumeStream()

    expect(doStream).toHaveBeenCalledOnce()
    expect(errorLog).toHaveBeenCalledExactlyOnceWith({ err: overloaded }, expect.any(String))
  })
})

describe("hasLlmBudget", () => {
  test("has budget when no model call happened in the last hour", async () => {
    expect(await hasLlmBudget()).toBe(true)
  })

  test("counts written incidents and assistant replies that used tokens from the last hour, edges included, up to the cap", async () => {
    await seedCalls(LLM_CALLS_PER_HOUR - 3, 30)
    await seedIncident(60, "written")
    await seedMessage(0, "assistant", 1)
    await seedIncident(5, "skipped_budget")
    await seedIncident(5, "failed")
    await seedMessage(5, "user", 1)
    await seedMessage(5, "assistant")
    await seedIncident(61, "written")
    await seedMessage(61, "assistant", 1)

    expect(await hasLlmBudget()).toBe(true)

    await seedIncident(30, "written")

    expect(await hasLlmBudget()).toBe(false)
  })
})

describe("hasLlmBudget: response summaries", () => {
  test("counts a response summary that used tokens by when its row was made", async () => {
    await seedCalls(LLM_CALLS_PER_HOUR - 1, 30)
    await seedSummary(5)
    await seedSummary(61, 500)

    expect(await hasLlmBudget()).toBe(true)

    await seedSummary(10, 500)

    expect(await hasLlmBudget()).toBe(false)
  })
})

describe("summarizeLlmUsage", () => {
  test("reports an empty hour as no calls, resetting now, with nothing spent today", async () => {
    await seedIncident(-5, "written")

    expect(await summarizeLlmUsage()).toStrictEqual({
      callsThisHour: 0,
      callsPerHour: LLM_CALLS_PER_HOUR,
      resetsAt: now,
      estimatedUsdToday: 0,
      cachedInputTokensToday: 0,
    })
  })

  test("counts the hour's calls, resets an hour after the oldest one, and prices every token since midnight UTC", async () => {
    await seedIncident(50, "written", 100)
    await seedMessage(20, "assistant", 10)
    await seedIncident(5, "skipped_budget")
    await seedMessage(5, "user")
    await seedIncident(55, "skipped_budget")
    await seedIncident(55, "failed")
    await seedMessage(55, "assistant")
    await seedMessage(55, "user", 1)
    await seedIncident(90, "written", 1000)
    await seedMessage(11 * 60, "assistant", 1)
    await seedMessage(12 * 60, "assistant", 3)
    await seedIncident(12 * 60 + 1, "written", 100_000)
    await seedMessage(13 * 60, "assistant", 100_000)
    await seedIncident(-5, "written", 100_000)
    await seedMessage(-5, "assistant", 100_000)

    expect(await summarizeLlmUsage()).toStrictEqual({
      callsThisHour: 2,
      callsPerHour: LLM_CALLS_PER_HOUR,
      resetsAt: new Date(now.getTime() + 10 * MILLISECONDS_PER_MINUTE),
      estimatedUsdToday: expect.closeTo(0.072475, 10),
      cachedInputTokensToday: 0,
    })
  })

  test("resets an hour after the oldest assistant reply when no incident report was written", async () => {
    await seedMessage(45, "assistant", 10)
    await seedMessage(10, "assistant", 10)

    const usage = await summarizeLlmUsage()

    expect(usage.callsThisHour).toBe(2)
    expect(usage.resetsAt).toStrictEqual(new Date(now.getTime() + 15 * MILLISECONDS_PER_MINUTE))
  })
})

describe("summarizeLlmUsage: response summaries", () => {
  test("counts this hour's summaries, resets an hour after the oldest one, and prices those made since midnight UTC", async () => {
    await seedMessage(20, "assistant", 10)
    await seedSummary(45)
    await seedSummary(40, 300)
    await seedSummary(5)
    await seedSummary(13 * 60, 100_000)

    expect(await summarizeLlmUsage()).toStrictEqual({
      callsThisHour: 2,
      callsPerHour: LLM_CALLS_PER_HOUR,
      resetsAt: new Date(now.getTime() + 20 * MILLISECONDS_PER_MINUTE),
      estimatedUsdToday: expect.closeTo(0.02015, 10),
      cachedInputTokensToday: 0,
    })
  })
})

describe("summarizeLlmUsage: cached input tokens", () => {
  test("adds up today's cached input tokens and prices them at the cached rate", async () => {
    await createIncident({
      ping: { connect: { id: seededPingIds[0] } },
      createdAt: minutesAgo(30),
      severity: "warning",
      durationMs: 900,
      averageDurationMs: 300,
      reportStatus: "written",
      inputTokens: 1000,
      cachedInputTokens: 400,
      outputTokens: 100,
    })
    await createMessage({
      id: randomUUID(),
      createdAt: minutesAgo(20),
      session: { connect: { id: SESSION_ID } },
      role: "assistant",
      parts: [{ type: "text", text: "Thirty pings ran." }],
      inputTokens: 2000,
      cachedInputTokens: 1000,
      outputTokens: 200,
    })
    await seedSummary(10, 500)

    expect(await summarizeLlmUsage()).toStrictEqual({
      callsThisHour: 3,
      callsPerHour: LLM_CALLS_PER_HOUR,
      resetsAt: new Date(now.getTime() + 30 * MILLISECONDS_PER_MINUTE),
      estimatedUsdToday: expect.closeTo(0.0502, 10),
      cachedInputTokensToday: 1400,
    })
  })
})

describe("estimateUsd", () => {
  test("prices input and output tokens per million for a listed model", () => {
    expect(estimateUsd({ inputTokens: 2_000_000, outputTokens: 500_000 }, "gpt-5.5")).toBeCloseTo(25, 10)
    expect(estimateUsd({ inputTokens: 1000, outputTokens: 2000 }, "gpt-5.5")).toBeCloseTo(0.065, 10)
  })

  test("falls back to the default price for a model not in the table", () => {
    expect(estimateUsd({ inputTokens: 2_000_000, outputTokens: 500_000 }, "some-unlisted-model")).toBeCloseTo(7.5, 10)
  })

  test("charges cached input tokens at a tenth of the input price, and only the rest at the full price", () => {
    const usage = { inputTokens: 2_000_000, cachedInputTokens: 1_000_000, outputTokens: 100_000 }

    expect(estimateUsd(usage, "gpt-5.5")).toBeCloseTo(8.5, 10)
    expect(estimateUsd(usage, "some-unlisted-model")).toBeCloseTo(2.375, 10)
  })

  test("prices tokens with no cached count as all uncached, never as NaN", () => {
    expect(estimateUsd({ inputTokens: 1000, outputTokens: 0 }, "gpt-5.5")).toBeCloseTo(0.005, 10)
  })
})

describe("toTokenUsage", () => {
  test("adds up the input, cached input and output tokens of every step of a streamed answer", async () => {
    replyInSteps(languageModel, [
      withCachedInputTokens(lookUpStep(1500, 10), 1024),
      withCachedInputTokens(textStep("The ping table has 42 rows.", 1700, 20), 1536),
    ])

    const answer = await streamAnswer({
      instructions: INSTRUCTIONS,
      messages: [userMessage("How many pings are there?")],
      tools: lookUpTool,
      promptCacheKey: CACHE_KEY,
    })

    expect(toTokenUsage(await answer.totalUsage)).toStrictEqual({
      inputTokens: 3200,
      cachedInputTokens: 2560,
      outputTokens: 30,
    })
  })

  test("counts missing counts as zero, including cacheReadTokens: undefined", () => {
    const usage: LanguageModelUsage = {
      inputTokens: 500,
      inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
      outputTokens: undefined,
      outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
      totalTokens: undefined,
    }

    expect(toTokenUsage(usage)).toStrictEqual({ inputTokens: 500, cachedInputTokens: 0, outputTokens: 0 })
  })
})
