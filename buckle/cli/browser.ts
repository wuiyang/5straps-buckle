export { isBrowserClose } from './usage.js'
import { BROWSER_CLOSE_USAGE as USAGE } from './usage.js'
export { BROWSER_CLOSE_USAGE as USAGE } from './usage.js'
import type { CliResult } from './result.js'
import type { BrowserCloseCounts } from '../common/domain/pack.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'





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
  // A browser left open, with what it holds, one a call still runs on, or an attached Chrome's hold kept, is a command
  // that did not finish (Codex review L1 to L3).
  const finished = counts.closed === counts.browsers && !counts.chromes
  return { exitCode: finished ? 0 : 1, detail: `closed ${counts.closed} of ${counts.browsers} browsers, dropped ${counts.held} held secret values${counts.kept ? `, kept ${counts.kept}` : ''}` }
}

/** Fixed text: an attached Chrome keeps its pages through a close, so its hold stays until it is found closed (Codex review L2). */
const CHROME_LEFT = 'An attached Chrome keeps its pages through a close, so what it was filled with stays held until this command, run while the workspace attaches to that Chrome, finds it closed: close every window of it, then run this command again.'

function chromesLeft(counts: BrowserCloseCounts): string {
  return counts.chromes ? ` ${CHROME_LEFT}` : ''
}

/** What buckle browser close prints, which docs/user/how-to/browser-login-02.md quotes. */
export function describeCounts(counts: BrowserCloseCounts, workspace: string): string {
  const values = `${counts.held} held secret ${counts.held === 1 ? 'value' : 'values'}`
  const kept = counts.kept ? ` ${counts.kept} held secret ${counts.kept === 1 ? 'value stays' : 'values stay'}.` : ''
  if (counts.browsers === 0) return `${counts.held === 0 && !counts.kept ? `No browser of workspace ${workspace} was recorded open, so nothing was closed.` : `No browser of workspace ${workspace} was recorded open; dropped ${values}.`}${kept}${chromesLeft(counts)}`
  const running = counts.busy ?? 0
  const failed = counts.browsers - counts.closed - running
  const left = failed === 0 ? '' : ` ${failed} did not close: ${failed === 1 ? 'it stays' : 'they stay'} recorded with what ${failed === 1 ? 'it holds' : 'they hold'}, and the next start or this command tries again.`
  const busy = running === 0 ? '' : ` ${running} ${running === 1 ? 'was' : 'were'} running a call: ${running === 1 ? 'it closes' : 'each closes'} when the last call on it ends, and holds what it held until then.`
  return `Closed ${counts.closed} of ${counts.browsers} ${counts.browsers === 1 ? 'browser' : 'browsers'} of workspace ${workspace}, and dropped ${values}.${kept}${left}${busy}${chromesLeft(counts)}`
}
