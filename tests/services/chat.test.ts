import { randomInt, randomUUID } from "node:crypto"
import { APICallError, type UIMessageChunk } from "ai"
import type { MockLanguageModelV4 } from "ai/test"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import { LLM_BASE_URL, LLM_CALLS_PER_HOUR, PING_INTERVAL_MS } from "@/config/env"
import { logger } from "@/config/logger"
import { database } from "@/db/client"
import type { Ping } from "@/db/generated/client"
import type { ChatMessage } from "@/lib/chat-request"
import { createMessages } from "@/models/message"
import {
  answerQuestion,
  isMissingChatSessionError,
  listRecentChatSessions,
  loadChatSession,
  startChatSession,
} from "@/services/chat"
import { streamAnswer, summarizeLlmUsage } from "@/services/llm"
import { deleteChatSessionsByIds, deletePingsByPayload } from "../support/database"
import {
  type ModelStreamPart,
  readStreamedText,
  readUIMessageChunks,
  replyInSteps,
  textStep,
  toolCallStep,
  withCachedInputTokens,
} from "../support/model-stream"

const builtModels = vi.hoisted(() => [] as MockLanguageModelV4[])

vi.mock("@ai-sdk/openai", async () => (await import("../support/model-provider")).mockOpenAIModule(builtModels))

vi.mock("@/services/llm", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/services/llm")>()
  return { ...original, streamAnswer: vi.fn(original.streamAnswer) }
})

vi.mock("@/models/message", { spy: true })

const MILLISECONDS_PER_MINUTE = 60_000

const MILLISECONDS_PER_DAY = 24 * 60 * MILLISECONDS_PER_MINUTE

const languageModel = builtModels[0]

const now = new Date(Date.UTC(2120, 0, 2, 12) + randomInt(0, 14_000) * MILLISECONDS_PER_DAY)

const minutesFromNow = (minutes: number) => new Date(now.getTime() + minutes * MILLISECONDS_PER_MINUTE)

const seedDayStart = new Date(now.getTime() - MILLISECONDS_PER_DAY)

const runMarker = { seeded: true, suite: "tests/services/chat", runId: randomUUID() }

const longSessionAge = new Date(Date.UTC(2000, 0, 1))

const createdSessionIds: string[] = []

const seededPings: Ping[] = []

const createSession = async () => {
  const session = await database.chatSession.create({ data: { id: randomUUID(), createdAt: longSessionAge } })
  createdSessionIds.push(session.id)
  return session.id
}

const question = (text: string): ChatMessage => ({ id: randomUUID(), role: "user", parts: [{ type: "text", text }] })

const uniqueQuestion = (text: string) => `${text} (run ${runMarker.runId})`

const ask = async (sessionId: string, messages: ChatMessage[]) =>
  readUIMessageChunks(await answerQuestion({ sessionId, messages }))

const findChunk = <Type extends UIMessageChunk["type"]>(chunks: UIMessageChunk[], type: Type) => {
  const found = chunks.find((chunk): chunk is Extract<UIMessageChunk, { type: Type }> => chunk.type === type)
  if (found === undefined) throw new Error(`The stream has no ${type} chunk`)
  return found
}

const listSavedMessages = (sessionId: string) =>
  database.message.findMany({ where: { sessionId }, orderBy: { createdAt: "asc" } })

const readHistory = async (sessionId: string) => (await loadChatSession(sessionId))?.messages ?? []

const findSessionTitle = async (sessionId: string) =>
  (await database.chatSession.findUnique({ where: { id: sessionId } }))?.title

const wordsOfTokens = (count: number) => " word".repeat(count)

const seededPingQuery = {
  table: "ping",
  method: "findMany",
  arguments: {
    where: { createdAt: { gte: seedDayStart.toISOString(), lt: now.toISOString() } },
    orderBy: [{ createdAt: "asc" }],
    select: { id: true, payload: true },
    take: 30,
  },
}

const seedChargedCalls = async (count: number, minutesAgo: number) => {
  const sessionId = await createSession()
  const callRow = () => ({
    id: randomUUID(),
    createdAt: minutesFromNow(-minutesAgo),
    sessionId,
    role: "assistant",
    parts: [],
    inputTokens: 100,
    outputTokens: 10,
  })
  await database.message.createMany({ data: Array.from({ length: count }, callRow) })
}

beforeAll(async () => {
  const pings = await Promise.all(
    Array.from({ length: 30 }, (_value, minute) =>
      database.ping.create({
        data: {
          createdAt: new Date(seedDayStart.getTime() + minute * MILLISECONDS_PER_MINUTE),
          payload: { ...runMarker, minute, filler: "x".repeat(400) },
          statusCode: 200,
          durationMs: 100 + minute,
          responseKind: "empty",
        },
      }),
    ),
  )
  seededPings.push(...pings.toSorted((first, second) => first.createdAt.getTime() - second.createdAt.getTime()))
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now })
})

afterEach(async () => {
  vi.useRealTimers()
  await deleteChatSessionsByIds(createdSessionIds.splice(0))
})

afterAll(async () => {
  await deletePingsByPayload("runId", [runMarker.runId])
})

describe("answerQuestion: model answers", () => {
  test("streams the answer, runs the queryDatabase tool on real rows, cuts its output to 8000 characters and saves the exchange", async () => {
    const sessionId = await createSession()
    const userQuestion = question(
      uniqueQuestion(
        "Which pings ran yesterday, and what did each one send to httpbin? List them all, oldest first, please.",
      ),
    )
    const doStream = replyInSteps(languageModel, [
      withCachedInputTokens(toolCallStep({ toolName: "queryDatabase", input: seededPingQuery }, 900, 40), 512),
      withCachedInputTokens(textStep("Thirty pings ran yesterday.", 1200, 25), 1024),
    ])

    const chunks = await ask(sessionId, [userQuestion])

    expect(readStreamedText(chunks)).toBe("Thirty pings ran yesterday.")
    const toolOutput = findChunk(chunks, "tool-output-available").output as { rows: unknown[]; truncated: boolean }
    const expectedRows = JSON.parse(
      JSON.stringify(seededPings.map((ping) => ({ id: ping.id, payload: ping.payload }))),
    ) as unknown[]
    expect(toolOutput.truncated).toBe(true)
    expect(toolOutput.rows).toStrictEqual(expectedRows.slice(0, toolOutput.rows.length))
    expect(JSON.stringify(toolOutput.rows).length).toBeLessThanOrEqual(8000)
    expect(JSON.stringify(expectedRows.slice(0, toolOutput.rows.length + 1)).length).toBeGreaterThan(8000)
    expect(doStream).toHaveBeenCalledTimes(2)
    expect(doStream.mock.calls[1][0].prompt).toContainEqual({
      role: "tool",
      content: [
        expect.objectContaining({
          type: "tool-result",
          toolName: "queryDatabase",
          output: { type: "json", value: toolOutput },
        }),
      ],
    })

    const answerId = findChunk(chunks, "start").messageId
    expect(answerId).toMatch(/^msg-/)
    expect(findChunk(chunks, "finish").messageMetadata).toStrictEqual({
      usage: { inputTokens: 2100, cachedInputTokens: 1536, outputTokens: 65 },
    })
    const [savedQuestion, savedAnswer] = await listSavedMessages(sessionId)
    expect(savedQuestion).toMatchObject({
      id: userQuestion.id,
      role: "user",
      parts: userQuestion.parts,
      questionHash: null,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      createdAt: now,
    })
    expect(savedAnswer).toMatchObject({
      id: answerId,
      role: "assistant",
      questionHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      inputTokens: 2100,
      cachedInputTokens: 1536,
      outputTokens: 65,
    })
    expect(savedAnswer.createdAt.getTime()).toBe(now.getTime() + 1)
    expect(savedAnswer.parts).toContainEqual(
      expect.objectContaining({
        type: "tool-queryDatabase",
        state: "output-available",
        input: seededPingQuery,
        output: toolOutput,
      }),
    )
    expect(savedAnswer.parts).toContainEqual(
      expect.objectContaining({ type: "text", text: "Thirty pings ran yesterday." }),
    )
    expect(await findSessionTitle(sessionId)).toBe(readQuestionText(userQuestion).slice(0, 80))
  })

  test("tells the model the current time, the ping interval and how to use the tool, with no propertyNames in the tool schema for OpenAI to strip", async () => {
    const sessionId = await createSession()
    const doStream = replyInSteps(languageModel, [textStep("Hello.", 300, 5)])

    await ask(sessionId, [question(uniqueQuestion("Hi"))])

    const [instructions] = doStream.mock.calls[0][0].prompt
    expect(instructions.role).toBe("system")
    expect(instructions.content).toContain(
      `It is now ${now.toISOString().slice(0, 16).replace("T", " ")} UTC, so today is ${now.toISOString().slice(0, 10)}.`,
    )
    expect(instructions.content).toContain(`Every ${PING_INTERVAL_MS / MILLISECONDS_PER_MINUTE} minutes it POSTs`)
    expect(instructions.content).toContain("Use the queryDatabase tool for every number you give")
    expect(instructions.content).toContain(
      "responseKind is how the monitor tagged the reply: clean_echo when httpbin echoed the payload back exactly",
    )
    expect(doStream.mock.calls[0][0].tools).toStrictEqual([
      expect.objectContaining({
        type: "function",
        name: "queryDatabase",
        description: expect.stringContaining("read-only Prisma query"),
      }),
    ])
    expect(doStream.mock.calls[0][0].tools?.[0]).toMatchObject({
      description: expect.stringContaining(
        "responseKind is one of clean_echo, echo_mismatch, empty, client_error, gateway_error or failed",
      ),
    })
    expect(doStream.mock.calls[0][0].providerOptions).toStrictEqual({
      openai: { store: false, promptCacheKey: "ping-monitor-chat" },
    })
    expect(JSON.stringify(doStream.mock.calls[0][0].tools)).not.toContain("propertyNames")
  })

  test("returns aggregates whole, and queries incidents too", async () => {
    const sessionId = await createSession()
    const incidentCount = {
      table: "incident",
      method: "aggregate",
      arguments: { where: { createdAt: { gte: seedDayStart.toISOString(), lt: now.toISOString() } }, _count: true },
    }
    replyInSteps(languageModel, [
      toolCallStep({ toolName: "queryDatabase", input: incidentCount }, 500, 20),
      textStep("No incidents.", 600, 5),
    ])

    const chunks = await ask(sessionId, [question(uniqueQuestion("How many incidents?"))])

    expect(findChunk(chunks, "tool-output-available").output).toStrictEqual({
      aggregate: { _count: 0 },
      truncated: false,
    })
  })

  test("hands a rejected query back to the model as a tool error", async () => {
    const sessionId = await createSession()
    const filterOnPayload = { table: "ping", method: "findMany", arguments: { where: { payload: { equals: {} } } } }
    const doStream = replyInSteps(languageModel, [
      toolCallStep({ toolName: "queryDatabase", input: filterOnPayload }, 500, 20),
      textStep("I can't filter on the payload.", 600, 5),
    ])

    const chunks = await ask(sessionId, [question(uniqueQuestion("Which pings sent an empty payload?"))])

    expect(findChunk(chunks, "tool-output-error").errorText).toMatch(/^The query was rejected\. /u)
    expect(doStream.mock.calls[1][0].prompt).toContainEqual({
      role: "tool",
      content: [
        expect.objectContaining({
          type: "tool-result",
          output: { type: "error-text", value: expect.stringContaining("The query was rejected.") },
        }),
      ],
    })
    expect(readStreamedText(chunks)).toBe("I can't filter on the payload.")
  })

  test("sends a follow-up with the whole conversation, keeps the title and caches the answer under every question so far", async () => {
    const sessionId = await createSession()
    replyInSteps(languageModel, [
      textStep("There were 30 pings.", 400, 10),
      textStep("All of them succeeded.", 500, 12),
    ])
    const firstQuestion = question(uniqueQuestion("How many pings ran?"))
    await ask(sessionId, [firstQuestion])
    vi.setSystemTime(minutesFromNow(5))
    const history = (await loadChatSession(sessionId))?.messages ?? []

    const chunks = await ask(sessionId, [...history, question("Did any fail?")])

    expect(readStreamedText(chunks)).toBe("All of them succeeded.")
    const savedMessages = await listSavedMessages(sessionId)
    expect(savedMessages.map((message) => [message.role, message.questionHash === null])).toStrictEqual([
      ["user", true],
      ["assistant", false],
      ["user", true],
      ["assistant", false],
    ])
    expect(savedMessages[3].questionHash).not.toBe(savedMessages[1].questionHash)
    expect(await findSessionTitle(sessionId)).toBe(readQuestionText(firstQuestion))
  })

  test("saves only the question, and logs, when the model fails before writing any text", async () => {
    const sessionId = await createSession()
    const overloaded = new APICallError({
      message: "upstream overloaded",
      url: LLM_BASE_URL,
      requestBodyValues: {},
      statusCode: 503,
    })
    vi.spyOn(languageModel, "doStream").mockRejectedValue(overloaded)
    const errorLog = vi.spyOn(logger, "error")
    const userQuestion = question(uniqueQuestion("Is httpbin up?"))

    const chunks = await ask(sessionId, [userQuestion])

    expect(findChunk(chunks, "error").errorText).toBe("An error occurred.")
    expect((await listSavedMessages(sessionId)).map((message) => message.id)).toStrictEqual([userQuestion.id])
    expect(errorLog).toHaveBeenCalledWith({ err: overloaded }, expect.any(String))
  })

  test("saves the whole answer with its tokens, and caches it, even when the browser disconnects mid-stream", async () => {
    const sessionId = await createSession()
    const doStream = replyInSteps(languageModel, [textStep("Thirty pings ran yesterday.", 400, 10)], 20)
    const response = await answerQuestion({
      sessionId,
      messages: [question(uniqueQuestion("How many pings ran yesterday, before I left?"))],
    })
    const reader = (response.body ?? new ReadableStream()).getReader()
    await reader.read()

    await reader.cancel()

    await vi.waitFor(async () => expect(await listSavedMessages(sessionId)).toHaveLength(2))
    const [, savedAnswer] = await listSavedMessages(sessionId)
    expect(savedAnswer).toMatchObject({
      role: "assistant",
      inputTokens: 400,
      outputTokens: 10,
      questionHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(savedAnswer.parts).toContainEqual(
      expect.objectContaining({ type: "text", text: "Thirty pings ran yesterday." }),
    )
    expect(doStream).toHaveBeenCalledOnce()
  })

  test("saves the model's steps and their tokens, uncached, when the browser disconnects early and the model runs out of steps without writing any text", async () => {
    const sessionId = await createSession()
    const incidentCount = { table: "incident", method: "aggregate", arguments: { _count: true } }
    const doStream = replyInSteps(
      languageModel,
      Array.from({ length: 4 }, () => toolCallStep({ toolName: "queryDatabase", input: incidentCount }, 500, 20)),
      20,
    )
    const response = await answerQuestion({
      sessionId,
      messages: [question(uniqueQuestion("Count the incidents again and again, then I'll stop you"))],
    })

    await response.body?.cancel()

    await vi.waitFor(async () => expect(await listSavedMessages(sessionId)).toHaveLength(2))
    const [, savedAnswer] = await listSavedMessages(sessionId)
    expect(savedAnswer).toMatchObject({ role: "assistant", inputTokens: 2000, outputTokens: 80, questionHash: null })
    expect(savedAnswer.parts).toContainEqual(
      expect.objectContaining({ type: "tool-queryDatabase", state: "output-available" }),
    )
    expect(doStream).toHaveBeenCalledTimes(4)
    expect((await summarizeLlmUsage()).callsThisHour).toBe(1)
  })

  test("saves an answer the model broke off partway, but never serves it from the cache", async () => {
    const [firstSessionId, secondSessionId] = [await createSession(), await createSession()]
    const brokenStep: ModelStreamPart[] = [
      ...textStep("Thirty", 400, 10).slice(0, 3),
      { type: "error", error: new Error("upstream reset") },
    ]
    const doStream = replyInSteps(languageModel, [brokenStep, textStep("Thirty pings ran.", 400, 10)])
    const repeatedQuestion = uniqueQuestion("How many pings ran, all told?")
    const firstChunks = await ask(firstSessionId, [question(repeatedQuestion)])

    const secondChunks = await ask(secondSessionId, [question(repeatedQuestion)])

    expect(findChunk(firstChunks, "error").errorText).toBe("An error occurred.")
    const [, brokenAnswer] = await listSavedMessages(firstSessionId)
    expect(brokenAnswer).toMatchObject({ role: "assistant", questionHash: null })
    expect(doStream).toHaveBeenCalledTimes(2)
    expect(readStreamedText(secondChunks)).toBe("Thirty pings ran.")
  })

  test("never saves token counts the browser put on the question", async () => {
    const sessionId = await createSession()
    replyInSteps(languageModel, [textStep("Hello.", 300, 5)])
    const forgedQuestion: ChatMessage = {
      ...question(uniqueQuestion("Hello?")),
      metadata: { usage: { inputTokens: 999_999, cachedInputTokens: 999_999, outputTokens: 999_999 } },
    }

    await ask(sessionId, [forgedQuestion])

    expect(
      (await listSavedMessages(sessionId)).map((message) => [
        message.role,
        message.inputTokens,
        message.cachedInputTokens,
        message.outputTokens,
      ]),
    ).toStrictEqual([
      ["user", 0, 0, 0],
      ["assistant", 300, 0, 5],
    ])
  })

  test("still streams the answer, and logs, when saving it fails", async () => {
    const sessionId = await createSession()
    const saveFailure = new Error("database is down")
    vi.mocked(createMessages).mockRejectedValueOnce(saveFailure)
    replyInSteps(languageModel, [textStep("All good.", 300, 5)])
    const errorLog = vi.spyOn(logger, "error")

    const chunks = await ask(sessionId, [question(uniqueQuestion("All good?"))])

    expect(readStreamedText(chunks)).toBe("All good.")
    expect(errorLog).toHaveBeenCalledExactlyOnceWith({ err: saveFailure, sessionId }, expect.any(String))
    expect(await listSavedMessages(sessionId)).toStrictEqual([])
  })
})

describe("answerQuestion: the answer cache", () => {
  test("serves a repeated first question from the cache within the hour, without calling the model or spending the budget", async () => {
    const [firstSessionId, secondSessionId] = [await createSession(), await createSession()]
    const doStream = replyInSteps(languageModel, [textStep("Thirty pings ran yesterday.", 800, 30)])
    await ask(firstSessionId, [question(uniqueQuestion("How many pings ran yesterday?"))])
    vi.setSystemTime(minutesFromNow(59))
    const repeatedQuestion = question(`  ${uniqueQuestion("HOW MANY PINGS RAN YESTERDAY?").toUpperCase()}  `)

    const chunks = await ask(secondSessionId, [repeatedQuestion])

    expect(doStream).toHaveBeenCalledOnce()
    expect(readStreamedText(chunks)).toBe("Thirty pings ran yesterday.")
    const cachedMetadata = { usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }, cached: true }
    expect(findChunk(chunks, "start").messageMetadata).toStrictEqual(cachedMetadata)
    expect(findChunk(chunks, "finish").messageMetadata).toStrictEqual(cachedMetadata)
    const [savedQuestion, savedCopy] = await listSavedMessages(secondSessionId)
    expect(savedQuestion).toMatchObject({ id: repeatedQuestion.id, role: "user" })
    expect(savedCopy).toMatchObject({
      id: findChunk(chunks, "start").messageId,
      role: "assistant",
      parts: [{ type: "text", text: "Thirty pings ran yesterday." }],
      questionHash: null,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    })
    expect(await findSessionTitle(secondSessionId)).toBe(readQuestionText(repeatedQuestion).trim().slice(0, 80))
    expect((await summarizeLlmUsage()).callsThisHour).toBe(1)
  })

  test("asks the model again once the cached answer is more than an hour old", async () => {
    const [firstSessionId, secondSessionId] = [await createSession(), await createSession()]
    const doStream = replyInSteps(languageModel, [textStep("Thirty.", 800, 30), textStep("Thirty-one.", 800, 30)])
    await ask(firstSessionId, [question(uniqueQuestion("How many pings ran?"))])
    vi.setSystemTime(minutesFromNow(61))

    const chunks = await ask(secondSessionId, [question(uniqueQuestion("How many pings ran?"))])

    expect(doStream).toHaveBeenCalledTimes(2)
    expect(readStreamedText(chunks)).toBe("Thirty-one.")
  })

  test("serves a follow-up from the cache when every question before it matches a conversation from the last hour, in another chat", async () => {
    const [firstSessionId, secondSessionId] = [await createSession(), await createSession()]
    const doStream = replyInSteps(languageModel, [
      textStep("Thirty pings ran.", 800, 30),
      textStep("The slowest took 1,035 ms.", 900, 20),
    ])
    const firstQuestionText = uniqueQuestion("How many pings ran today?")
    await ask(firstSessionId, [question(firstQuestionText)])
    await ask(firstSessionId, [...(await readHistory(firstSessionId)), question("And the slowest?")])
    vi.setSystemTime(minutesFromNow(30))
    await ask(secondSessionId, [question(firstQuestionText)])

    const chunks = await ask(secondSessionId, [
      ...(await readHistory(secondSessionId)),
      question("  AND THE SLOWEST?  "),
    ])

    expect(doStream).toHaveBeenCalledTimes(2)
    expect(readStreamedText(chunks)).toBe("The slowest took 1,035 ms.")
    expect(findChunk(chunks, "finish").messageMetadata).toStrictEqual({
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      cached: true,
    })
    expect((await summarizeLlmUsage()).callsThisHour).toBe(2)
  })

  test("asks the model again for the same follow-up after a different first question", async () => {
    const [firstSessionId, secondSessionId] = [await createSession(), await createSession()]
    const doStream = replyInSteps(languageModel, [
      textStep("Thirty pings ran.", 800, 30),
      textStep("The slowest took 1,035 ms.", 900, 20),
      textStep("Two incidents.", 800, 30),
      textStep("The slowest incident's ping took 6,046 ms.", 900, 20),
    ])
    await ask(firstSessionId, [question(uniqueQuestion("How many pings ran today?"))])
    await ask(firstSessionId, [...(await readHistory(firstSessionId)), question("And the slowest?")])
    await ask(secondSessionId, [question(uniqueQuestion("How many incidents were there today?"))])

    const chunks = await ask(secondSessionId, [...(await readHistory(secondSessionId)), question("And the slowest?")])

    expect(doStream).toHaveBeenCalledTimes(4)
    expect(readStreamedText(chunks)).toBe("The slowest incident's ping took 6,046 ms.")
  })
})

describe("answerQuestion: refusals and failures", () => {
  test("answers with the reset time when the hourly budget is spent, and saves the refusal without counting it as a call", async () => {
    await seedChargedCalls(LLM_CALLS_PER_HOUR, 10)
    const sessionId = await createSession()
    const doStream = vi.spyOn(languageModel, "doStream")

    const chunks = await ask(sessionId, [question(uniqueQuestion("How slow was httpbin today?"))])

    const resetTime = minutesFromNow(50).toISOString().slice(11, 16)
    expect(readStreamedText(chunks)).toBe(`The model budget for this hour is spent. It resets at ${resetTime} UTC.`)
    expect(findChunk(chunks, "finish").messageMetadata).toStrictEqual({
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    })
    expect(doStream).not.toHaveBeenCalled()
    expect(
      (await listSavedMessages(sessionId)).map((message) => [message.role, message.inputTokens, message.questionHash]),
    ).toStrictEqual([
      ["user", 0, null],
      ["assistant", 0, null],
    ])
    expect((await summarizeLlmUsage()).callsThisHour).toBe(LLM_CALLS_PER_HOUR)
  })

  test("answers that a question over 6000 tokens is too long, and saves that", async () => {
    const sessionId = await createSession()
    const doStream = vi.spyOn(languageModel, "doStream")

    const chunks = await ask(sessionId, [question(wordsOfTokens(6001))])

    expect(readStreamedText(chunks)).toBe("That question is too long for one call. Ask something shorter.")
    expect(doStream).not.toHaveBeenCalled()
    expect(await listSavedMessages(sessionId)).toHaveLength(2)
  })

  test.each([new Error("database is down"), "not an error"])(
    "passes any other failure on, and saves nothing: %s",
    async (failure) => {
      const sessionId = await createSession()
      vi.mocked(streamAnswer).mockRejectedValueOnce(failure)

      await expect(answerQuestion({ sessionId, messages: [question(uniqueQuestion("Anything?"))] })).rejects.toBe(
        failure,
      )

      expect(await listSavedMessages(sessionId)).toStrictEqual([])
    },
  )

  test("throws a missing-session error for an unknown session", async () => {
    const unknownId = `missing-${randomUUID()}`

    const failure = await answerQuestion({ sessionId: unknownId, messages: [question("Hello?")] }).catch(
      (error: unknown) => error,
    )

    expect(failure).toStrictEqual(new Error(`No chat session with id ${unknownId}`))
    expect(isMissingChatSessionError(failure)).toBe(true)
    expect(isMissingChatSessionError(new Error(`No chat session with id ${unknownId}`))).toBe(false)
    expect(isMissingChatSessionError("No chat session")).toBe(false)
  })
})

describe("chat sessions", () => {
  test("starts an untitled session and returns it", async () => {
    const session = await startChatSession()
    createdSessionIds.push(session.id)

    expect(session).toStrictEqual({ id: expect.any(String), createdAt: expect.any(Date), title: null })
    expect(await database.chatSession.findUnique({ where: { id: session.id } })).toStrictEqual(session)
  })

  test("loads a session and its messages as UI messages, oldest first, with usage on answers", async () => {
    const sessionId = await createSession()
    const userQuestion = question(uniqueQuestion("How many pings ran?"))
    replyInSteps(languageModel, [textStep("Thirty.", 400, 10)])
    const chunks = await ask(sessionId, [userQuestion])

    expect(await loadChatSession(sessionId)).toStrictEqual({
      session: { id: sessionId, createdAt: longSessionAge, title: readQuestionText(userQuestion) },
      messages: [
        { ...userQuestion, metadata: undefined },
        {
          id: findChunk(chunks, "start").messageId,
          role: "assistant",
          parts: [{ type: "step-start" }, { type: "text", text: "Thirty.", state: "done" }],
          metadata: { usage: { inputTokens: 400, cachedInputTokens: 0, outputTokens: 10 } },
        },
      ],
    })
  })

  test("returns null for a session that doesn't exist", async () => {
    expect(await loadChatSession(`missing-${randomUUID()}`)).toBeNull()
  })

  test("lists at most 20 sessions, newest first", async () => {
    const session = await database.chatSession.create({ data: { id: randomUUID(), createdAt: now, title: "Newest" } })
    createdSessionIds.push(session.id)

    const sessions = await listRecentChatSessions()

    expect(sessions.length).toBeLessThanOrEqual(20)
    expect(sessions).toContainEqual({ id: session.id, createdAt: now, title: "Newest" })
    const createdAtTimes = sessions.map((listed) => listed.createdAt.getTime())
    expect(createdAtTimes).toStrictEqual(createdAtTimes.toSorted((first, second) => second - first))
  })
})

const readQuestionText = (message: ChatMessage) =>
  message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
