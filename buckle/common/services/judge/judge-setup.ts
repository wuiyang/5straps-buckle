import type { NodeConfig } from '../../runtime/config.js'
import { resolveSettings, type WorkspaceSettings } from '../workspaces/workspace-settings.js'

/**
 * What `buckle serve` says once at start about the decision AI (D91, addendum A): each online workspace whose judge is
 * on but cannot rate, so it stays off there, with the key it lacks, by name and never by value.
 * Null where every workspace's judge is off or set up.
 */
export function judgeSetupNotice(input: { config: Pick<NodeConfig, 'judgeApiKey' | 'workspaceDefaults'>; workspaces: ReadonlyArray<{ name: string; settings: WorkspaceSettings }> }): string | null {
  const gaps = input.workspaces.flatMap(({ name, settings }) => {
    const { approval } = resolveSettings(settings, input.config.workspaceDefaults)
    if (approval.judge === 'off') return []
    const missing = input.config.judgeApiKey ? [] : ['BUCKLE_JUDGE_API_KEY']
    return missing.length === 0 ? [] : [`${name} (${missing.join(', ')})`]
  })
  if (gaps.length === 0) return null
  return `The decision AI is on but stays off until the node holds its key, in workspace${gaps.length === 1 ? '' : 's'} ${gaps.join('; ')}: the key goes in buckle.env by hand`
}
