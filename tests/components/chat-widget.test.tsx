import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { ChatWidget } from "@/components/chat-widget"
import type { ChatMessage, ChatSessionSummary, LoadedChatSession } from "@/lib/chat-request"

const STORAGE_KEY = "chat-session-id"

const SESSION_ONE: ChatSessionSummary = {
  id: "session-1",
  title: "Failed pings",
  createdAt: "2026-10-01T10:00:00.000Z",
}

const SESSION_TWO: ChatSessionSummary = { id: "session-2", title: "Slow pings", createdAt: "2026-10-01T09:00:00.000Z" }

const NEW_SESSION: ChatSessionSummary = { id: "session-new", title: null, createdAt: "2026-10-02T08:00:00.000Z" }

const FIRST_QUESTION: ChatMessage = {
  id: "message-1",
  role: "user",
  parts: [{ type: "text", text: "How many pings failed today?" }],
}

const FIRST_ANSWER: ChatMessage = {
  id: "message-2",
  role: "assistant",
  parts: [{ type: "text", text: "Three pings failed today." }],
  metadata: { usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 240 } },
}

const SAVED_CONVERSATIONS: Record<string, LoadedChatSession> = {
  "session-1": { session: SESSION_ONE, messages: [FIRST_QUESTION, FIRST_ANSWER] },
  "session-2": {
    session: SESSION_TWO,
    messages: [
      { id: "message-3", role: "user", parts: [{ type: "text", text: "Which ping was slowest?" }] },
      { id: "message-4", role: "assistant", parts: [{ type: "text", text: "Ping 42 took 9 seconds." }] },
    ],
  },
}

const answerChunks = (text: string) => [
  { type: "start", messageId: `answer-${text.length}` },
  { type: "text-start", id: "text-1" },
  { type: "text-delta", id: "text-1", delta: text },
  { type: "text-end", id: "text-1" },
  { type: "finish", finishReason: "stop", messageMetadata: { usage: { inputTokens: 100, outputTokens: 20 } } },
]

const encodeEvents = (chunks: unknown[]) => chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const streamedAnswer = (text: string) =>
  new Response(`${encodeEvents(answerChunks(text))}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })

const heldAnswer = (text: string) => {
  const encoder = new TextEncoder()
  const held: { controller?: ReadableStreamDefaultController<Uint8Array> } = {}
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      held.controller = controller
    },
  })
  const [start, ...rest] = answerChunks(text)
  const send = (chunks: unknown[]) => held.controller?.enqueue(encoder.encode(encodeEvents(chunks)))
  send([start])
  const finish = () => {
    send(rest)
    held.controller?.close()
  }
  return { response: new Response(body, { headers: { "content-type": "text/event-stream" } }), finish }
}

type FetchCall = { method: string; url: string; body: unknown }

const stubServer = (answerChat: () => Response = () => streamedAnswer("Two pings failed.")) => {
  const calls: FetchCall[] = []
  const fixedResponses = new Map([
    ["POST /api/chat/sessions", () => jsonResponse(NEW_SESSION, 201)],
    ["POST /api/chat", answerChat],
    ["GET /api/chat/sessions", () => jsonResponse({ sessions: [SESSION_ONE, SESSION_TWO] })],
  ])
  const respond = (method: string, url: string) => {
    const fixedResponse = fixedResponses.get(`${method} ${url}`)
    if (fixedResponse !== undefined) return fixedResponse()
    const savedConversation = SAVED_CONVERSATIONS[url.replace("/api/chat/sessions/", "")]
    return savedConversation === undefined
      ? jsonResponse({ error: "No chat session" }, 404)
      : jsonResponse(savedConversation)
  }
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    const url = String(input)
    calls.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined })
    return respond(method, url)
  })
  vi.stubGlobal("fetch", fetchStub)
  return calls
}

const blockStorage = () => {
  throw new Error("localStorage is blocked")
}

const describeCalls = (calls: FetchCall[]) => calls.map((call) => `${call.method} ${call.url}`)

const openPanel = async () => {
  fireEvent.click(screen.getByRole("button", { name: /^Open chat/u }))
  return screen.findByRole("dialog")
}

const panelTitle = () => within(screen.getByRole("dialog")).getByRole("heading", { level: 2 }).textContent

const askQuestion = (text: string) => {
  const questionBox = screen.getByRole("textbox", { name: "Your question" })
  fireEvent.change(questionBox, { target: { value: text } })
  fireEvent.keyDown(questionBox, { key: "Enter" })
}

beforeEach(() => {
  window.localStorage.clear()
})

describe("ChatWidget", () => {
  test("is closed by default and fetches nothing until it opens", () => {
    const calls = stubServer()
    render(<ChatWidget />)

    expect(screen.getByRole("button", { name: "Open chat" }).getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(calls).toEqual([])
  })

  test("opens an empty chat on click without creating a session", async () => {
    const calls = stubServer()
    render(<ChatWidget />)

    const panel = await openPanel()

    expect(panelTitle()).toBe("Chat")
    expect(within(panel).getByText("No questions yet")).toBeDefined()
    expect(within(panel).getByRole("list", { name: "Suggested questions" })).toBeDefined()
    expect(calls).toEqual([])
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  test("creates a session on the first question, stores its id, and sends the question with it", async () => {
    const calls = stubServer()
    render(<ChatWidget />)
    await openPanel()

    askQuestion("How many pings failed this week?")

    expect(await screen.findByText("Two pings failed.")).toBeDefined()
    expect(describeCalls(calls)).toEqual(["POST /api/chat/sessions", "POST /api/chat"])
    expect(calls[1].body).toMatchObject({
      id: "session-new",
      messages: [{ role: "user", parts: [{ type: "text", text: "How many pings failed this week?" }] }],
    })
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("session-new")
    expect(panelTitle()).toBe("How many pings failed this week?")
  })

  test("sends a follow-up on the same session without creating another", async () => {
    const calls = stubServer()
    render(<ChatWidget />)
    await openPanel()
    askQuestion("How many pings failed this week?")
    await screen.findByText("Two pings failed.")

    askQuestion("And today?")

    await waitFor(() => expect(calls).toHaveLength(3))
    expect(describeCalls(calls)).toEqual(["POST /api/chat/sessions", "POST /api/chat", "POST /api/chat"])
    expect(calls[2].body).toMatchObject({ id: "session-new" })
    expect((calls[2].body as { messages: unknown[] }).messages).toHaveLength(3)
  })

  test("shows the error with Retry when the session can't be started, and Retry tries again", async () => {
    const calls = stubServer()
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: "down" }, 500))
    render(<ChatWidget />)
    await openPanel()

    askQuestion("Any incidents?")

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("Could not start a chat session. Try again.")
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }))
    expect(await screen.findByText("Two pings failed.")).toBeDefined()
    expect(describeCalls(calls)).toEqual(["POST /api/chat/sessions", "POST /api/chat"])
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("session-new")
  })

  test("loads the stored session when the panel opens, and answers on it", async () => {
    window.localStorage.setItem(STORAGE_KEY, "session-1")
    const calls = stubServer()
    render(<ChatWidget />)

    await openPanel()

    expect(await screen.findByText("Three pings failed today.")).toBeDefined()
    expect(screen.getByText("How many pings failed today?")).toBeDefined()
    expect(panelTitle()).toBe("Failed pings")
    askQuestion("Which one was first?")
    await screen.findByText("Two pings failed.")
    expect(describeCalls(calls)).toEqual(["GET /api/chat/sessions/session-1", "POST /api/chat"])
    expect(calls[1].body).toMatchObject({ id: "session-1" })
  })

  test("clears a stored id the server doesn't know and starts an empty chat", async () => {
    window.localStorage.setItem(STORAGE_KEY, "session-gone")
    const calls = stubServer()
    render(<ChatWidget />)

    await openPanel()

    expect(await screen.findByText("No questions yet")).toBeDefined()
    expect(describeCalls(calls)).toEqual(["GET /api/chat/sessions/session-gone"])
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(panelTitle()).toBe("Chat")
  })

  test("keeps the stored id when the server fails for another reason, and starts an empty chat", async () => {
    window.localStorage.setItem(STORAGE_KEY, "session-1")
    stubServer()
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: "down" }, 500))
    render(<ChatWidget />)

    await openPanel()

    expect(await screen.findByText("No questions yet")).toBeDefined()
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("session-1")
  })

  test("still works when the browser blocks localStorage", async () => {
    const storageAccess = vi.spyOn(window, "localStorage", "get").mockImplementation(blockStorage)
    const calls = stubServer()
    render(<ChatWidget />)

    await openPanel()
    askQuestion("How many pings failed this week?")

    expect(await screen.findByText("Two pings failed.")).toBeDefined()
    fireEvent.click(screen.getByRole("button", { name: "New chat" }))
    expect(await screen.findByText("No questions yet")).toBeDefined()
    expect(describeCalls(calls)).toEqual(["POST /api/chat/sessions", "POST /api/chat"])
    expect(storageAccess).toHaveBeenCalledTimes(3)
  })

  test("New chat clears the stored id and the messages", async () => {
    window.localStorage.setItem(STORAGE_KEY, "session-1")
    const calls = stubServer()
    render(<ChatWidget />)
    await openPanel()
    await screen.findByText("Three pings failed today.")

    fireEvent.click(screen.getByRole("button", { name: "New chat" }))

    expect(await screen.findByText("No questions yet")).toBeDefined()
    expect(screen.queryByText("Three pings failed today.")).toBeNull()
    expect(panelTitle()).toBe("Chat")
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    askQuestion("Start over?")
    await screen.findByText("Two pings failed.")
    expect(describeCalls(calls)).toEqual([
      "GET /api/chat/sessions/session-1",
      "POST /api/chat/sessions",
      "POST /api/chat",
    ])
  })

  test("the history menu lists recent sessions when it opens, marks the current one, and loads the picked one", async () => {
    window.localStorage.setItem(STORAGE_KEY, "session-1")
    const calls = stubServer()
    render(<ChatWidget />)
    await openPanel()
    await screen.findByText("Three pings failed today.")

    fireEvent.click(screen.getByRole("button", { name: "Recent chats" }))

    const menu = await screen.findByRole("menu")
    const items = await within(menu).findAllByRole("menuitemradio")
    expect(items.map((item) => [item.textContent, item.getAttribute("aria-checked")])).toEqual([
      ["Failed pings", "true"],
      ["Slow pings", "false"],
    ])
    expect(describeCalls(calls)).toEqual(["GET /api/chat/sessions/session-1", "GET /api/chat/sessions"])
    fireEvent.click(items[1])
    expect(await screen.findByText("Ping 42 took 9 seconds.")).toBeDefined()
    expect(panelTitle()).toBe("Slow pings")
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("session-2")
    expect(screen.queryByText("Three pings failed today.")).toBeNull()
  })

  test("the history menu says so when the recent sessions can't load", async () => {
    stubServer()
    render(<ChatWidget />)
    await openPanel()
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: "down" }, 500))

    fireEvent.click(screen.getByRole("button", { name: "Recent chats" }))

    expect(await screen.findByText("Could not load recent chats.")).toBeDefined()
  })

  test("shows a pulsing dot on the button while an answer streams with the panel closed, and keeps the answer", async () => {
    const answer = heldAnswer("Two pings failed.")
    stubServer(() => answer.response)
    render(<ChatWidget />)
    await openPanel()
    askQuestion("How many pings failed this week?")
    await screen.findByRole("button", { name: "Stop" })

    fireEvent.click(screen.getByRole("button", { name: "Close chat" }))

    const launcher = await screen.findByRole("button", { name: "Open chat, an answer is streaming" })
    expect(launcher.querySelector('[aria-hidden="true"].animate-pulse')).not.toBeNull()
    await act(async () => answer.finish())
    expect(await screen.findByRole("button", { name: "Open chat" })).toBeDefined()
    expect(launcher.querySelector(".animate-pulse")).toBeNull()
    await openPanel()
    expect(await screen.findByText("Two pings failed.")).toBeDefined()
  })

  test("shows no dot while an answer streams with the panel open", async () => {
    const answer = heldAnswer("Two pings failed.")
    stubServer(() => answer.response)
    render(<ChatWidget />)
    await openPanel()

    askQuestion("How many pings failed this week?")

    await screen.findByRole("button", { name: "Stop" })
    expect(screen.queryByRole("button", { name: "Open chat, an answer is streaming" })).toBeNull()
    await act(async () => answer.finish())
  })
})
