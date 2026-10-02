import { randomInt } from "node:crypto"
import type { MockLanguageModelV4 } from "ai/test"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import * as zod from "zod"
import { modelUsage } from "../support/model-stream"

const providerSettings = vi.hoisted(() => ({ openai: [] as unknown[], gateway: [] as unknown[] }))

const builtModels = vi.hoisted(() => [] as MockLanguageModelV4[])

vi.mock("@ai-sdk/openai", async () =>
  (await import("../support/model-provider")).mockOpenAIModule(builtModels, providerSettings.openai),
)

vi.mock("@ai-sdk/gateway", async () =>
  (await import("../support/model-provider")).mockGatewayModule(builtModels, providerSettings.gateway),
)

const GATEWAY_KEY = "test-gateway-key"

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

const now = new Date(Date.UTC(1980, 0, 1, 12) + randomInt(0, 3600) * MILLISECONDS_PER_DAY)

const reportSchema = zod.object({ summary: zod.string() })

const loadModelLayer = async (gatewayKey: string) => {
  vi.stubEnv("AI_GATEWAY_API_KEY", gatewayKey)
  vi.resetModules()
  const { logger } = await import("@/config/logger")
  const infoLog = vi.spyOn(logger, "info")
  const modelLayer = await import("@/services/llm")
  const settings = await import("@/config/env")
  return { modelLayer, settings, infoLog }
}

beforeEach(() => {
  providerSettings.openai.splice(0)
  providerSettings.gateway.splice(0)
  builtModels.splice(0)
  vi.useFakeTimers({ toFake: ["Date"], now })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe("the model provider", () => {
  test("uses the OpenAI-compatible endpoint's Responses API when no gateway key is set, and says so once", async () => {
    const { settings, infoLog } = await loadModelLayer("")

    expect(providerSettings.openai).toStrictEqual([{ baseURL: settings.LLM_BASE_URL, apiKey: settings.LLM_API_KEY }])
    expect(providerSettings.gateway).toStrictEqual([])
    expect(builtModels).toMatchObject([{ provider: "openai.responses", modelId: "gpt-5.5" }])
    expect(infoLog).toHaveBeenCalledExactlyOnceWith(
      { provider: "openai-compatible", baseURL: settings.LLM_BASE_URL, model: "gpt-5.5" },
      expect.any(String),
    )
  })

  test("uses the AI Gateway with its key and the model under openai/ when the key is set, and never logs the key", async () => {
    const { infoLog } = await loadModelLayer(GATEWAY_KEY)

    expect(providerSettings.gateway).toStrictEqual([{ apiKey: GATEWAY_KEY }])
    expect(providerSettings.openai).toStrictEqual([])
    expect(builtModels).toMatchObject([{ provider: "gateway", modelId: "openai/gpt-5.5" }])
    expect(infoLog).toHaveBeenCalledExactlyOnceWith(
      { provider: "ai-gateway", model: "openai/gpt-5.5" },
      expect.any(String),
    )
    expect(JSON.stringify(infoLog.mock.calls)).not.toContain(GATEWAY_KEY)
  })

  test("sends the JSON schema, the prompt cache key and a 24-hour cache retention through the gateway", async () => {
    const { modelLayer } = await loadModelLayer(GATEWAY_KEY)
    const doGenerate = vi.spyOn(builtModels[0], "doGenerate").mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ summary: "httpbin answered slowly" }) }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: modelUsage(1400, 50, 1280),
      warnings: [],
    })

    const structured = await modelLayer.generateStructured({
      schema: reportSchema,
      instructions: "You write short incident reports.",
      prompt: "The ping took 900 ms.",
      promptCacheKey: "ping-monitor-incident",
    })

    expect(structured).toStrictEqual({
      output: { summary: "httpbin answered slowly" },
      usage: { inputTokens: 1400, cachedInputTokens: 1280, outputTokens: 50 },
    })
    expect(doGenerate.mock.calls[0][0]).toMatchObject({
      responseFormat: { type: "json", schema: expect.objectContaining({ required: ["summary"] }) },
    })
    expect(doGenerate.mock.calls[0][0].providerOptions).toStrictEqual({
      openai: { store: false, promptCacheKey: "ping-monitor-incident", promptCacheRetention: "24h" },
    })
  })
})
