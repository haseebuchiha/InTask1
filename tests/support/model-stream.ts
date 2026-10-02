import { simulateReadableStream, type UIMessageChunk } from "ai"
import type { MockLanguageModelV4 } from "ai/test"
import { vi } from "vitest"

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>

export type ModelStreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never

export const modelUsage = (inputTokens?: number, outputTokens?: number, cachedInputTokens?: number) => ({
  inputTokens: {
    total: inputTokens,
    noCache: inputTokens === undefined ? undefined : inputTokens - (cachedInputTokens ?? 0),
    cacheRead: cachedInputTokens,
    cacheWrite: undefined,
  },
  outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
})

export const withCachedInputTokens = (step: ModelStreamPart[], cachedInputTokens: number): ModelStreamPart[] =>
  step.map((chunk) =>
    chunk.type === "finish"
      ? {
          ...chunk,
          usage: { ...chunk.usage, inputTokens: { ...chunk.usage.inputTokens, cacheRead: cachedInputTokens } },
        }
      : chunk,
  )

export const textStep = (text: string, inputTokens?: number, outputTokens?: number): ModelStreamPart[] => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "text-1" },
  { type: "text-delta", id: "text-1", delta: text },
  { type: "text-end", id: "text-1" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: modelUsage(inputTokens, outputTokens) },
]

type ToolCall = { toolName: string; input: unknown }

export const toolCallStep = (
  { toolName, input }: ToolCall,
  inputTokens: number,
  outputTokens: number,
): ModelStreamPart[] => [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: `call-${toolName}`, toolName, input: JSON.stringify(input) },
  {
    type: "finish",
    finishReason: { unified: "tool-calls", raw: "tool_calls" },
    usage: modelUsage(inputTokens, outputTokens),
  },
]

export const replyInSteps = (
  model: MockLanguageModelV4,
  steps: ModelStreamPart[][],
  chunkDelayInMs: number | null = null,
) => {
  const doStream = vi.spyOn(model, "doStream")
  steps.forEach((chunks) =>
    doStream.mockResolvedValueOnce({
      stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs }),
    }),
  )
  return doStream
}

export const readUIMessageChunks = async (response: Response) => {
  const body = await response.text()
  const events = body.split("\n\n").filter((event) => event.startsWith("data: ") && event !== "data: [DONE]")
  return events.map((event) => JSON.parse(event.slice("data: ".length)) as UIMessageChunk)
}

export const readStreamedText = (chunks: UIMessageChunk[]) =>
  chunks.flatMap((chunk) => (chunk.type === "text-delta" ? [chunk.delta] : [])).join("")
