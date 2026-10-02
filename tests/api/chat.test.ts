import { randomInt, randomUUID } from "node:crypto"
import type { MockLanguageModelV4 } from "ai/test"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { POST as chatRoute } from "@/app/api/chat/route"
import { GET as loadSessionRoute } from "@/app/api/chat/sessions/[id]/route"
import { GET as listSessionsRoute, POST as startSessionRoute } from "@/app/api/chat/sessions/route"
import { database } from "@/db/client"
import { answerQuestion } from "@/services/chat"
import { deleteChatSessionsByIds } from "../support/database"
import { readStreamedText, readUIMessageChunks, replyInSteps, textStep } from "../support/model-stream"

const builtModels = vi.hoisted(() => [] as MockLanguageModelV4[])

vi.mock("@ai-sdk/openai", async () => (await import("../support/model-provider")).mockOpenAIModule(builtModels))

vi.mock("@/services/chat", { spy: true })

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

const INVALID_CHAT_REQUEST_MESSAGE =
  "The body must be JSON like { id, messages }: id is a chat session id, and messages is a non-empty list of UI messages that ends with the user's question"

type SessionBody = { id: string; createdAt: string; title: string | null }

type SessionListBody = { sessions: SessionBody[] }

const languageModel = builtModels[0]

const now = new Date(Date.UTC(2160, 0, 2, 12) + randomInt(0, 14_000) * MILLISECONDS_PER_DAY)

const RUN_ID = randomUUID()

const createdSessionIds: string[] = []

const createSession = async (createdAt = new Date(Date.UTC(2000, 0, 1))) => {
  const session = await database.chatSession.create({ data: { id: randomUUID(), createdAt } })
  createdSessionIds.push(session.id)
  return session.id
}

const question = (text: string) => ({ id: randomUUID(), role: "user", parts: [{ type: "text", text }] })

const postChat = (body: unknown) =>
  chatRoute(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  )

const getSession = (id: string) =>
  loadSessionRoute(new Request(`http://localhost/api/chat/sessions/${encodeURIComponent(id)}`), {
    params: Promise.resolve({ id }),
  })

const startSession = async () => {
  const response = await startSessionRoute()
  const session = (await response.json()) as SessionBody
  createdSessionIds.push(session.id)
  return { response, session }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now })
})

afterEach(async () => {
  vi.useRealTimers()
  await deleteChatSessionsByIds(createdSessionIds.splice(0))
})

describe("POST /api/chat", () => {
  test("streams the answer as a UI message stream and saves the exchange", async () => {
    const sessionId = await createSession()
    replyInSteps(languageModel, [textStep("Every ping succeeded.", 300, 8)])

    const response = await postChat({ id: sessionId, messages: [question(`Did any ping fail? (run ${RUN_ID})`)] })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1")
    const chunks = await readUIMessageChunks(response)
    expect(readStreamedText(chunks)).toBe("Every ping succeeded.")
    expect(chunks.at(-1)).toStrictEqual({
      type: "finish",
      finishReason: "stop",
      messageMetadata: { usage: { inputTokens: 300, cachedInputTokens: 0, outputTokens: 8 } },
    })
    expect(await database.message.count({ where: { sessionId } })).toBe(2)
  })

  test("returns 404 for a session that doesn't exist", async () => {
    const unknownId = `missing-${randomUUID()}`

    const response = await postChat({ id: unknownId, messages: [question("Hello?")] })

    expect(response.status).toBe(404)
    expect(await response.json()).toStrictEqual({ error: `No chat session with id ${unknownId}` })
  })

  test.each([
    { name: "a body that isn't JSON", body: "{ not json" },
    { name: "a missing id", body: { messages: [question("Hello?")] } },
    { name: "an empty id", body: { id: "", messages: [question("Hello?")] } },
    { name: "an id that isn't text", body: { id: 42, messages: [question("Hello?")] } },
    { name: "no messages", body: { id: "some-session", messages: [] } },
    { name: "messages that aren't a list", body: { id: "some-session", messages: "Hello?" } },
    { name: "a message without parts", body: { id: "some-session", messages: [{ id: "one", role: "user" }] } },
    {
      name: "a message with an unknown role",
      body: { id: "some-session", messages: [{ id: "one", role: "robot", parts: [{ type: "text", text: "Hi" }] }] },
    },
    {
      name: "a conversation that ends with the assistant",
      body: {
        id: "some-session",
        messages: [question("Hello?"), { id: "two", role: "assistant", parts: [{ type: "text", text: "Hi" }] }],
      },
    },
  ])("returns 400 for $name", async ({ body }) => {
    const response = await postChat(body)

    expect(response.status).toBe(400)
    expect(await response.json()).toStrictEqual({ error: INVALID_CHAT_REQUEST_MESSAGE })
  })

  test("lets any other failure through", async () => {
    const sessionId = await createSession()
    const failure = new Error("database is down")
    vi.mocked(answerQuestion).mockRejectedValueOnce(failure)

    await expect(postChat({ id: sessionId, messages: [question("Hello?")] })).rejects.toBe(failure)
  })
})

describe("GET /api/chat/sessions", () => {
  test("lists the most recent sessions, newest first", async () => {
    const sessionId = await createSession(now)

    const response = await listSessionsRoute()
    const body = (await response.json()) as SessionListBody

    expect(response.status).toBe(200)
    expect(Object.keys(body)).toStrictEqual(["sessions"])
    expect(body.sessions.length).toBeLessThanOrEqual(20)
    expect(body.sessions).toContainEqual({ id: sessionId, createdAt: now.toISOString(), title: null })
    const createdAtTimes = body.sessions.map((session) => new Date(session.createdAt).getTime())
    expect(createdAtTimes).toStrictEqual(createdAtTimes.toSorted((first, second) => second - first))
  })
})

describe("POST /api/chat/sessions", () => {
  test("starts an untitled session and returns it with status 201", async () => {
    const { response, session } = await startSession()

    expect(response.status).toBe(201)
    expect(session).toStrictEqual({
      id: expect.stringMatching(/^[\w-]{1,64}$/u),
      createdAt: expect.any(String),
      title: null,
    })
    expect(await database.chatSession.findUnique({ where: { id: session.id } })).toStrictEqual({
      id: session.id,
      createdAt: new Date(session.createdAt),
      title: null,
    })
  })

  test("starts a different session on every call", async () => {
    const first = await startSession()
    const second = await startSession()

    expect(first.session.id).not.toBe(second.session.id)
  })

  test("returns an id that POST /api/chat answers on, and the first question titles the session", async () => {
    const { session } = await startSession()
    replyInSteps(languageModel, [textStep("Two pings failed.", 300, 8)])
    const questionText = `How many pings failed? (run ${RUN_ID})`

    const response = await postChat({ id: session.id, messages: [question(questionText)] })

    expect(response.status).toBe(200)
    expect(readStreamedText(await readUIMessageChunks(response))).toBe("Two pings failed.")
    expect(await database.chatSession.findUnique({ where: { id: session.id } })).toMatchObject({ title: questionText })
  })
})

describe("GET /api/chat/sessions/:id", () => {
  test("returns the session and its messages, oldest first, with usage on the answer", async () => {
    const sessionId = await createSession(now)
    const userQuestion = question(`Did any ping fail? (run ${RUN_ID})`)
    replyInSteps(languageModel, [textStep("Every ping succeeded.", 300, 8)])
    await readUIMessageChunks(await postChat({ id: sessionId, messages: [userQuestion] }))

    const response = await getSession(sessionId)

    expect(response.status).toBe(200)
    expect(await response.json()).toStrictEqual({
      session: { id: sessionId, createdAt: now.toISOString(), title: `Did any ping fail? (run ${RUN_ID})` },
      messages: [
        userQuestion,
        {
          id: expect.any(String),
          role: "assistant",
          parts: [{ type: "step-start" }, { type: "text", text: "Every ping succeeded.", state: "done" }],
          metadata: { usage: { inputTokens: 300, cachedInputTokens: 0, outputTokens: 8 } },
        },
      ],
    })
  })

  test("returns an untitled session with no messages yet", async () => {
    const sessionId = await createSession(now)

    const response = await getSession(sessionId)

    expect(response.status).toBe(200)
    expect(await response.json()).toStrictEqual({
      session: { id: sessionId, createdAt: now.toISOString(), title: null },
      messages: [],
    })
  })

  test.each([
    { name: "a session that doesn't exist", id: `missing-${randomUUID()}` },
    { name: "an id with characters a session id never has", id: "not a session!" },
    { name: "an id longer than 64 characters", id: "a".repeat(65) },
  ])("returns 404 for $name", async ({ id }) => {
    const response = await getSession(id)

    expect(response.status).toBe(404)
    expect(await response.json()).toStrictEqual({ error: `No chat session with id ${id}` })
  })
})
