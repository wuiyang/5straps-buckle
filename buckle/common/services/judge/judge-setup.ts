import type { NodeConfig } from '../../runtime/config.js'
import { resolveSettings, type WorkspaceSettings } from '../workspaces/workspace-settings.js'

/**
 * What `buckle serve` says once at start about the decision AI (D91, addenda A and 2 B): each online workspace whose
 * judge is on but whose thorough stage, or the quick stage it names, cannot rate, so that stage stays off there, with the
 * key it lacks, by name and never by value.
 * Null where every workspace's judge is off or set up.
 */
export function judgeSetupNotice(input: { config: Pick<NodeConfig, 'judgeApiKey' | 'quickJudgeApiKey' | 'workspaceDefaults'>; workspaces: ReadonlyArray<{ name: string; settings: WorkspaceSettings }> }): string | null {
  const gaps = input.workspaces.flatMap(({ name, settings }) => {
    const { approval } = resolveSettings(settings, input.config.workspaceDefaults)
    if (approval.judge === 'off') return []
    const missing = [
      ...(input.config.judgeApiKey ? [] : ['BUCKLE_JUDGE_API_KEY']),
      ...(approval.quickJudge === 'off' || input.config.quickJudgeApiKey ? [] : ['BUCKLE_QUICK_JUDGE_API_KEY']),
    ]
    return missing.length === 0 ? [] : [`${name} (${missing.join(', ')})`]
  })
  if (gaps.length === 0) return null
  return `The decision AI is on, but a stage of it stays off until the node holds its key, in workspace${gaps.length === 1 ? '' : 's'} ${gaps.join('; ')}: each key goes in buckle.env by hand`
}
