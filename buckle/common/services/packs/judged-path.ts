import type { PathView } from '../../domain/path-view.js'
import { ToolInputError, type ToolContext } from '../../domain/tool.js'
import { resolveTarget } from '../invocation/real-path.js'

/**
 * Where a path the agent named lands now, refused unless its permission check judged that place: a
 * link swapped in while the call waited for approval is refused rather than followed. A tool that hands
 * a path to another program (host git, agent-browser) hands it this judged real path, never the name
 * (review L5 of the second proof-of-possession re-review). Without the call's judged targets (a tool
 * run outside the invoker) the landing is returned unchecked.
 */
export function judgedPath(input: { named: string; kind: 'read' | 'write'; paths: PathView; context: Pick<ToolContext, 'authorizeReadTarget' | 'authorizeWrite'> }): string {
  const target = resolveTarget(input.paths.resolve(input.named), { shares: input.paths.shares })
  const authorize = input.kind === 'read' ? input.context.authorizeReadTarget : input.context.authorizeWrite
  if (authorize && !authorize(target)) throw new ToolInputError(`${input.named} now resolves to a place its permission check did not see; send the call again`, { code: 'PERMISSION_DENIED' })
  return target
}
