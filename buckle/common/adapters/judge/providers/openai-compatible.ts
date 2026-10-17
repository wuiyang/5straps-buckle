import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { ProviderModel } from '../ai-sdk.js'
import type { ProviderSettings } from '../providers.js'

/** Where an OpenAI-compatible judge is asked when the node names no BUCKLE_JUDGE_BASE_URL: OpenAI's own API. */
export const OPENAI_COMPATIBLE_BASE_URL = 'https://api.openai.com/v1'

/**
 * The `openai-compatible` provider (D91, addendum 2 A), the one module that imports `@ai-sdk/openai-compatible`: any
 * endpoint that speaks OpenAI's chat completions, such as an AI gateway or a local model, at the node's base URL, with
 * the node's key as `Authorization: Bearer` and nothing the environment holds (the provider reads no variable when it is
 * given a key). Structured outputs ask for a strict JSON schema answer.
 */
export function openAiCompatibleModels(settings: ProviderSettings): (modelId: string) => ProviderModel {
  const provider = createOpenAICompatible({
    name: 'buckle-judge',
    baseURL: settings.baseUrl ?? OPENAI_COMPATIBLE_BASE_URL,
    apiKey: settings.apiKey,
    supportsStructuredOutputs: true,
    ...(settings.fetch ? { fetch: settings.fetch } : {}),
  })
  return modelId => provider.chatModel(modelId)
}
