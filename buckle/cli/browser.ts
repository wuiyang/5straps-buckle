import type { BrowserCloseCounts } from '../common/domain/pack.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'

export interface CliResult {
  exitCode: number
  detail?: string
}

export const USAGE = `Usage: buckle browser close [--workspace <name>]
Closes every browser the workspace's agents left open, in every Buckle process on this machine, and drops the secret
values their pages hold. It needs no running node; a running node finds them gone at its next call.`

/** Whether a command line is the owner's `buckle browser close`, never a browser tool, which `buckle browser command` runs. */
export function isBrowserClose(command: string, argv: readonly string[]): boolean {
  return command === 'browser' && argv[0] === 'close'
}

/**
 * `buckle browser close` (Slice F4, item 6): every browser the workspace recorded is closed under the sessions lock, a
 * bare close each, in parallel under one bound, and every record and hold is forgotten. Prints the counts.
 */
export async function browserCloseCommand(runtime: BuckleRuntime, argv: readonly string[]): Promise<CliResult> {
  if (argv.length > 1) {
    process.stderr.write(`${USAGE}\n`)
    return { exitCode: 1 }
  }
  const counts = await runtime.closeBrowsers()
  process.stdout.write(`${describeCounts(counts, runtime.workspaceName())}\n`)
  return { exitCode: 0, detail: `closed ${counts.closed} of ${counts.browsers} browsers, dropped ${counts.held} held secret values` }
}

function describeCounts(counts: BrowserCloseCounts, workspace: string): string {
  const values = `${counts.held} held secret ${counts.held === 1 ? 'value' : 'values'}`
  if (counts.browsers === 0) return counts.held === 0 ? `No browser of workspace ${workspace} was recorded open, so nothing was closed.` : `No browser of workspace ${workspace} was recorded open; dropped ${values}.`
  const failed = counts.browsers - counts.closed
  const left = failed === 0 ? '' : ` ${failed} did not close; agent-browser's idle timeout ends ${failed === 1 ? 'it' : 'them'}.`
  return `Closed ${counts.closed} of ${counts.browsers} ${counts.browsers === 1 ? 'browser' : 'browsers'} of workspace ${workspace}, and dropped ${values}.${left}`
}
