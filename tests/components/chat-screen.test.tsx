import type { Chat } from "@ai-sdk/react"
import { fireEvent, render, screen, within } from "@testing-library/react"
import type { UIMessage } from "ai"
import { describe, expect, test, vi } from "vitest"
import { ChatScreen, ChatTitle } from "@/components/chat-screen"
import type { ChatMessage } from "@/lib/chat-request"

const { useChat } = vi.hoisted(() => ({ useChat: vi.fn() }))

vi.mock("@ai-sdk/react", () => ({ useChat }))

const USER_QUESTION: UIMessage = {
  id: "message-1",
  role: "user",
  parts: [{ type: "text", text: "How many pings failed today?" }],
}

const ASSISTANT_ANSWER: UIMessage = {
  id: "message-2",
  role: "assistant",
  metadata: { usage: { inputTokens: 1000, outputTokens: 240 } },
  parts: [
    { type: "step-start" },
    { type: "reasoning", text: "", state: "done" },
    {
      type: "tool-queryDatabase",
      toolCallId: "call-1",
      state: "output-available",
      input: { table: "ping", method: "aggregate", arguments: { _count: true } },
      output: { aggregate: { _count: 3 }, truncated: false },
    },
    { type: "step-start" },
    { type: "text", text: "Three pings failed today." },
  ],
}

const CHAT = { id: "chat-1" } as unknown as Chat<ChatMessage>

type MockedChat = {
  messages: UIMessage[]
  status: "submitted" | "streaming" | "ready" | "error"
  error: Error | undefined
  sendMessage: ReturnType<typeof vi.fn>
  regenerate: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
}

const streamingAnswer = (parts: UIMessage["parts"]): UIMessage => ({ id: "message-5", role: "assistant", parts })

const thinkingLineIn = (align: string) => {
  const thinking = screen.getByRole("status")
  expect(thinking.textContent).toContain("Thinking…")
  expect(thinking.closest('[data-slot="message"]')?.getAttribute("data-align")).toBe(align)
}

const mockChat = (overrides: Partial<MockedChat>) => {
  const chat: MockedChat = {
    messages: [],
    status: "ready",
    error: undefined,
    sendMessage: vi.fn(),
    regenerate: vi.fn(),
    stop: vi.fn(),
    ...overrides,
  }
  useChat.mockReturnValue(chat)
  return chat
}

const renderChat = (overrides: Partial<MockedChat> = {}) => {
  const chat = mockChat(overrides)
  render(<ChatScreen chat={CHAT} />)
  return chat
}

const renderTitle = (title: string | null, messages: UIMessage[] = []) => {
  mockChat({ messages })
  render(
    <h2>
      <ChatTitle chat={CHAT} title={title} />
    </h2>,
  )
  return screen.getByRole("heading", { level: 2 }).textContent
}

const questionBox = () => screen.getByRole("textbox", { name: "Your question" })

describe("ChatScreen", () => {
  test("subscribes to the chat it is given", () => {
    renderChat()
    expect(useChat).toHaveBeenCalledWith({ chat: CHAT })
  })

  test("renders the user's question and the assistant's answer", () => {
    renderChat({ messages: [USER_QUESTION, ASSISTANT_ANSWER] })
    expect(screen.getByText("How many pings failed today?")).toBeDefined()
    expect(screen.getByText("Three pings failed today.")).toBeDefined()
  })

  test("renders a queryDatabase call on the ping table as a collapsed Queried pings block with its state", () => {
    renderChat({ messages: [USER_QUESTION, ASSISTANT_ANSWER] })
    const toolTrigger = screen.getByRole("button", { name: /Queried pings/u })
    expect(within(toolTrigger).getByText("Completed")).toBeDefined()
    expect(toolTrigger.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByText("Parameters")).toBeNull()
  })

  test("titles a query on the incident table Queried incidents", () => {
    const incidentQuery: UIMessage = {
      id: "message-3",
      role: "assistant",
      parts: [
        {
          type: "tool-queryDatabase",
          toolCallId: "call-2",
          state: "input-available",
          input: { table: "incident", method: "findMany", arguments: {} },
        },
      ],
    }
    renderChat({ messages: [USER_QUESTION, incidentQuery], status: "streaming" })
    const toolTrigger = screen.getByRole("button", { name: /Queried incidents/u })
    expect(within(toolTrigger).getByText("Running")).toBeDefined()
  })

  test("shows the token count under an answer, and from cache when it came from the cache", () => {
    const cachedAnswer: UIMessage = {
      ...ASSISTANT_ANSWER,
      id: "message-4",
      metadata: { usage: { inputTokens: 20, outputTokens: 5 }, cached: true },
    }
    renderChat({ messages: [USER_QUESTION, ASSISTANT_ANSWER, cachedAnswer] })
    expect(screen.getByText("1,240 tokens")).toBeDefined()
    expect(screen.getByText("25 tokens, from cache")).toBeDefined()
  })

  test("adds the input tokens the provider served from its prompt cache to an answer's token line", () => {
    const partlyCachedAnswer: UIMessage = {
      ...ASSISTANT_ANSWER,
      metadata: { usage: { inputTokens: 1000, cachedInputTokens: 300, outputTokens: 240 } },
    }
    renderChat({ messages: [USER_QUESTION, partlyCachedAnswer] })
    expect(screen.getByText("1,240 tokens (300 cached)")).toBeDefined()
  })

  test("shows no usage line under the user's question", () => {
    renderChat({ messages: [USER_QUESTION] })
    expect(screen.queryByText(/tokens/u)).toBeNull()
  })

  test("shows the loader while the question is submitted", () => {
    renderChat({ messages: [USER_QUESTION], status: "submitted" })
    const thinking = screen.getByRole("status")
    expect(thinking.textContent).toContain("Thinking…")
    expect(within(thinking).getByTitle("Loader")).toBeDefined()
  })

  test("keeps Thinking… on the answer's side once the empty answer arrives", () => {
    renderChat({ messages: [USER_QUESTION, streamingAnswer([])], status: "submitted" })
    expect(screen.getAllByRole("status")).toHaveLength(1)
    thinkingLineIn("start")
  })

  test("shows Thinking… inside a streaming answer that only holds a reasoning part", () => {
    const reasoningOnly = streamingAnswer([{ type: "step-start" }, { type: "reasoning", text: "", state: "streaming" }])
    renderChat({ messages: [USER_QUESTION, reasoningOnly], status: "streaming" })
    expect(screen.getAllByRole("status")).toHaveLength(1)
    thinkingLineIn("start")
  })

  test("shows Thinking… under a finished query while the next step starts", () => {
    renderChat({ messages: [USER_QUESTION, streamingAnswer(ASSISTANT_ANSWER.parts.slice(0, 4))], status: "streaming" })
    expect(within(screen.getByRole("button", { name: /Queried pings/u })).getByText("Completed")).toBeDefined()
    thinkingLineIn("start")
  })

  test("hides Thinking… once the answer streams text", () => {
    renderChat({ messages: [USER_QUESTION, streamingAnswer(ASSISTANT_ANSWER.parts)], status: "streaming" })
    expect(screen.getByText("Three pings failed today.")).toBeDefined()
    expect(screen.queryByRole("status")).toBeNull()
  })

  test("shows a query as soon as its input starts streaming, with a Pending badge instead of Thinking…", () => {
    const pendingQuery = streamingAnswer([
      { type: "step-start" },
      { type: "reasoning", text: "", state: "done" },
      { type: "tool-queryDatabase", toolCallId: "call-3", state: "input-streaming", input: undefined },
    ])
    renderChat({ messages: [USER_QUESTION, pendingQuery], status: "streaming" })
    expect(within(screen.getByRole("button", { name: /Queried the database/u })).getByText("Pending")).toBeDefined()
    expect(screen.queryByRole("status")).toBeNull()
  })

  test("hides the loader once the answer is ready", () => {
    renderChat({ messages: [USER_QUESTION, ASSISTANT_ANSWER] })
    expect(screen.queryByText("Thinking…")).toBeNull()
  })

  test("disables the question box while an answer streams, and Stop stops it", () => {
    const chat = renderChat({ messages: [USER_QUESTION], status: "streaming" })
    expect(questionBox().hasAttribute("disabled")).toBe(true)
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Stop" }))
    expect(chat.stop).toHaveBeenCalledOnce()
  })

  test("Enter sends the trimmed question and clears the box", () => {
    const chat = renderChat()
    fireEvent.change(questionBox(), { target: { value: "  Which ping was slowest?  " } })
    fireEvent.keyDown(questionBox(), { key: "Enter" })
    expect(chat.sendMessage).toHaveBeenCalledWith({ text: "Which ping was slowest?" })
    expect((questionBox() as HTMLTextAreaElement).value).toBe("")
  })

  test("Shift+Enter does not send", () => {
    const chat = renderChat()
    fireEvent.change(questionBox(), { target: { value: "First line" } })
    fireEvent.keyDown(questionBox(), { key: "Enter", shiftKey: true })
    expect(chat.sendMessage).not.toHaveBeenCalled()
  })

  test("the Send button sends, and stays disabled while the box is empty", () => {
    const chat = renderChat()
    const sendButton = screen.getByRole("button", { name: "Send" })
    expect(sendButton.hasAttribute("disabled")).toBe(true)
    fireEvent.change(questionBox(), { target: { value: "Any incidents?" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    expect(chat.sendMessage).toHaveBeenCalledWith({ text: "Any incidents?" })
  })

  test("an empty conversation offers three suggestions, and picking one sends it", () => {
    const chat = renderChat()
    const suggestions = within(screen.getByRole("list", { name: "Suggested questions" })).getAllByRole("button")
    expect(suggestions.map((suggestion) => suggestion.textContent)).toEqual([
      "What were the slowest pings today?",
      "Summarize incidents in the last 24 hours",
      "How many pings failed this week?",
    ])
    fireEvent.click(screen.getByRole("button", { name: "How many pings failed this week?" }))
    expect(chat.sendMessage).toHaveBeenCalledWith({ text: "How many pings failed this week?" })
  })

  test("hides the suggestions once the conversation has messages", () => {
    renderChat({ messages: [USER_QUESTION, ASSISTANT_ANSWER] })
    expect(screen.queryByRole("list", { name: "Suggested questions" })).toBeNull()
  })

  test("shows the error with a Retry button that resends the last question", () => {
    const chat = renderChat({
      messages: [USER_QUESTION],
      status: "error",
      error: new Error("The model is unavailable"),
    })
    const alert = screen.getByRole("alert")
    expect(alert.textContent).toContain("The model is unavailable")
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }))
    expect(chat.regenerate).toHaveBeenCalledOnce()
  })
})

describe("ChatTitle", () => {
  test("shows the session's title", () => {
    expect(renderTitle("Failed pings", [USER_QUESTION])).toBe("Failed pings")
    expect(useChat).toHaveBeenCalledWith({ chat: CHAT })
  })

  test("shows the first 80 characters of an untitled chat's first question once one is asked", () => {
    const longQuestion: UIMessage = {
      id: "message-4",
      role: "user",
      parts: [{ type: "text", text: `  ${"Why ".repeat(30)}  ` }],
    }
    expect(renderTitle(null, [longQuestion])).toBe("Why ".repeat(30).trim().slice(0, 80))
  })

  test("shows Chat for an untitled chat with no questions", () => {
    expect(renderTitle(null)).toBe("Chat")
  })
})
