import type { Judge, JudgeProvider } from '../../types/ports/judge.js'

/**
 * The judge a provider names, with the node's key, and its base URL for an OpenAI-compatible endpoint alone: the
 * Anthropic adapter asks Anthropic's API and nothing else. Each adapter, and the SDK it imports, loads at its first
 * rating, so a node whose judge is off never loads either. `fetch` is for tests.
 */
export function createProviderJudge(options: { provider: JudgeProvider; apiKey: string; baseUrl?: string; fetch?: typeof fetch }): Judge {
  let loaded: Promise<Judge> | undefined
  const load = (): Promise<Judge> => {
    const fetch = options.fetch ? { fetch: options.fetch } : {}
    loaded ??= options.provider === 'anthropic'
      ? import('./anthropic.js').then(module => module.createAnthropicJudge({ apiKey: options.apiKey, ...fetch }))
      : import('./openai.js').then(module => module.createOpenAiJudge({ apiKey: options.apiKey, ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}), ...fetch }))
    return loaded
  }
  return { judge: async (input, judging) => (await load()).judge(input, judging) }
}
