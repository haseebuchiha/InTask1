import { randomInt, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { createChatSession, findChatSessionById, listChatSessions, updateChatSessionTitle } from "@/models/chat-session"
import {
  countChargedAssistantMessagesSince,
  createMessage,
  createMessages,
  findCachedAssistantMessage,
  findOldestChargedAssistantMessageSince,
  listMessagesBySession,
  sumMessageTokensSince,
} from "@/models/message"
import { deleteChatSessionsByIds } from "../support/database"

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000

const windowStart = new Date(Date.UTC(4000, 0, 1) + randomInt(0, 36_000) * 24 * MILLISECONDS_PER_HOUR)

const hourOf = (hour: number) => new Date(windowStart.getTime() + hour * MILLISECONDS_PER_HOUR)

const SESSION_ID = randomUUID()

const UNCACHED_SESSION_ID = randomUUID()

const QUESTION_HASH = `tests/models/message ${randomUUID()}`

const textParts = (text: string) => [{ type: "text", text }]

const seededMessage = (role: string, hour: number, tokens: number) => ({
  id: randomUUID(),
  createdAt: hourOf(hour),
  sessionId: SESSION_ID,
  role,
  parts: textParts(`${role} at hour ${hour}`),
  questionHash: role === "assistant" ? QUESTION_HASH : null,
  inputTokens: tokens,
  outputTokens: tokens * 2,
})

beforeAll(async () => {
  await createChatSession(SESSION_ID)
  await createMessages([seededMessage("user", 1, 0), seededMessage("assistant", 2, 10), seededMessage("user", 3, 0)])
  await createMessage({
    id: randomUUID(),
    createdAt: hourOf(4),
    session: { connect: { id: SESSION_ID } },
    role: "assistant",
    parts: textParts("latest"),
    questionHash: QUESTION_HASH,
    inputTokens: 5,
    cachedInputTokens: 3,
    outputTokens: 7,
  })
  await createChatSession(UNCACHED_SESSION_ID)
  await createMessage({
    id: randomUUID(),
    createdAt: hourOf(2.5),
    session: { connect: { id: UNCACHED_SESSION_ID } },
    role: "assistant",
    parts: textParts("no model call"),
    questionHash: null,
  })
})

afterAll(async () => {
  await deleteChatSessionsByIds([SESSION_ID, UNCACHED_SESSION_ID])
})

describe("chat session and message models", () => {
  test("loads a session with its messages oldest first", async () => {
    const session = await findChatSessionById(SESSION_ID)
    const messages = await listMessagesBySession(SESSION_ID)

    expect(session?.messages.map((message) => message.role)).toStrictEqual(["user", "assistant", "user", "assistant"])
    expect(messages.map((message) => message.createdAt)).toStrictEqual([1, 2, 3, 4].map(hourOf))
  })

  test("lists sessions newest first", async () => {
    const sessions = await listChatSessions(5)
    const createdAtTimes = sessions.map((session) => session.createdAt.getTime())

    expect(sessions.map((session) => session.id)).toContain(SESSION_ID)
    expect(createdAtTimes).toStrictEqual(createdAtTimes.toSorted((first, second) => second - first))
  })

  test("counts assistant messages that used tokens and sums tokens since a time", async () => {
    expect(await countChargedAssistantMessagesSince(hourOf(1))).toBe(2)
    expect(await countChargedAssistantMessagesSince(hourOf(3))).toBe(1)
    expect(await sumMessageTokensSince(hourOf(1))).toStrictEqual({
      inputTokens: 15,
      cachedInputTokens: 3,
      outputTokens: 27,
    })
    expect(await sumMessageTokensSince(hourOf(5))).toStrictEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    })
  })

  test("bounds the reads by an end time and finds the oldest assistant message in the range", async () => {
    expect(await countChargedAssistantMessagesSince(hourOf(1), hourOf(3))).toBe(1)
    expect(await sumMessageTokensSince(hourOf(1), hourOf(3))).toStrictEqual({
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 20,
    })
    expect(await findOldestChargedAssistantMessageSince(hourOf(1), hourOf(5))).toStrictEqual({ createdAt: hourOf(2) })
    expect(await findOldestChargedAssistantMessageSince(hourOf(2.25), hourOf(5))).toStrictEqual({
      createdAt: hourOf(4),
    })
    expect(await findOldestChargedAssistantMessageSince(hourOf(5), hourOf(6))).toBeNull()
  })

  test("finds the newest cached answer for a question inside the window", async () => {
    const cached = await findCachedAssistantMessage(QUESTION_HASH, hourOf(1))

    expect(cached?.parts).toStrictEqual(textParts("latest"))
    expect(await findCachedAssistantMessage(QUESTION_HASH, hourOf(5))).toBeNull()
    expect(await findCachedAssistantMessage("unknown question", hourOf(1))).toBeNull()
  })

  test("skips a message whose id is already saved", async () => {
    const repeated = { ...seededMessage("user", 5, 0), sessionId: UNCACHED_SESSION_ID }

    await createMessages([repeated])
    const saved = await createMessages([repeated, { ...seededMessage("user", 6, 0), sessionId: UNCACHED_SESSION_ID }])

    expect(saved.count).toBe(1)
    expect(
      (await listMessagesBySession(UNCACHED_SESSION_ID)).filter((message) => message.id === repeated.id),
    ).toHaveLength(1)
  })

  test("sets a session's title", async () => {
    await updateChatSessionTitle(UNCACHED_SESSION_ID, "How slow was httpbin?")

    expect((await findChatSessionById(UNCACHED_SESSION_ID))?.title).toBe("How slow was httpbin?")
  })
})
