import type { QuickJudge, QuickJudgeProvider } from '../../types/ports/quick-judge.js'
import type { ProviderSettings } from './providers.js'

/**
 * Each provider approval.quickJudgeProvider may name, as the module that builds its quick judge (D91, addendum 2 B). A
 * new provider is one adapter file and one entry here and in QUICK_JUDGE_PROVIDERS.
 */
const QUICK_PROVIDERS: Readonly<Record<QuickJudgeProvider, () => Promise<(settings: ProviderSettings) => QuickJudge>>> = {
  typesafe: () => import('./typesafe.js').then(module => (settings: ProviderSettings) => module.createTypeSafeQuickJudge(settings)),
}

/** The quick judge a provider names, with the node's key and base URL; its adapter loads at the first rating. */
export function createProviderQuickJudge(options: { provider: QuickJudgeProvider } & ProviderSettings): QuickJudge {
  let loaded: Promise<QuickJudge> | undefined
  const load = (): Promise<QuickJudge> => {
    const { provider, ...settings } = options
    loaded ??= QUICK_PROVIDERS[provider]().then(build => build(settings))
    return loaded
  }
  return { quick: async (input, options) => (await load()).quick(input, options) }
}
