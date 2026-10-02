import { MockLanguageModelV4 } from "ai/test"

export const mockOpenAIModule = (builtModels: MockLanguageModelV4[], providerSettings: unknown[] = []) => ({
  createOpenAI: (settings: unknown) => {
    providerSettings.push(settings)
    return { responses: recordingModelBuilder(builtModels, "openai.responses") }
  },
})

export const mockGatewayModule = (builtModels: MockLanguageModelV4[], providerSettings: unknown[] = []) => ({
  createGateway: (settings: unknown) => {
    providerSettings.push(settings)
    return recordingModelBuilder(builtModels, "gateway")
  },
})

const recordingModelBuilder = (builtModels: MockLanguageModelV4[], provider: string) => (modelId: string) => {
  const model = new MockLanguageModelV4({ provider, modelId })
  builtModels.push(model)
  return model
}
