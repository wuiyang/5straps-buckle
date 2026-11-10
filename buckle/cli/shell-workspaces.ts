import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import type { CliResult } from './result.js'
import { WORKSPACES_USAGE } from './usage.js'
import { fail, print } from './output.js'
export { WORKSPACES_USAGE } from './usage.js'

export async function shellWorkspacesCommand(runtime: BuckleRuntime, argv: string[]): Promise<CliResult> {
  const [command = 'list', id] = argv
  if (command === 'list') return print(runtime.shellWorkspaces.list())
  if (command === 'prune') return print(await runtime.shellWorkspaces.prune())
  if (command === 'inspect' && id) return print(await runtime.shellWorkspaces.inspect(id))
  if (command === 'publish' && id) return print(await runtime.shellWorkspaces.publish(id))
  if (command === 'discard' && id) return print(await runtime.shellWorkspaces.discard(id))
  return fail(WORKSPACES_USAGE)
}
