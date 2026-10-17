import type { Judge, JudgeProvider } from '../../types/ports/judge.js'
import type { ProviderModel } from './ai-sdk.js'

/** What a provider is built from: the node's key and, where it names one, its base URL; `fetch` is for tests. */
export interface ProviderSettings {
  apiKey: string
  baseUrl?: string
  fetch?: typeof fetch
}

type ProviderModels = (settings: ProviderSettings) => (modelId: string) => ProviderModel

/**
 * Each provider approval.judgeProvider may name, as the module that builds its models (D91, addendum 2 A). A new
 * provider is one file under providers/ and one entry here and in JUDGE_PROVIDERS; nothing else changes.
 */
const PROVIDERS: Readonly<Record<JudgeProvider, () => Promise<ProviderModels>>> = {
  'openai-compatible': () => import('./providers/openai-compatible.js').then(module => module.openAiCompatibleModels),
}

/**
 * The judge a provider names, with the node's key and base URL. The AI SDK adapter and the provider's module load at
 * the first rating, so a node whose judge is off loads neither.
 */
export function createProviderJudge(options: { provider: JudgeProvider } & ProviderSettings): Judge {
  let loaded: Promise<Judge> | undefined
  const load = (): Promise<Judge> => {
    const { provider, ...settings } = options
    loaded ??= Promise.all([import('./ai-sdk.js'), PROVIDERS[provider]()]).then(([adapter, models]) => adapter.createAiSdkJudge({ model: models(settings) }))
    return loaded
  }
  return { judge: async (input, judging) => (await load()).judge(input, judging) }
}
