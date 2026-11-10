import { CHECK_URL_USAGE as USAGE } from './usage.js'
export { CHECK_URL_USAGE as USAGE } from './usage.js'
import type { CliResult } from './result.js'
import { CHECK_URL_BAD_INPUT } from './exit-codes.js'
export { CHECK_URL_BAD_INPUT } from './exit-codes.js'
import { parseArgs } from 'node:util'
import { normaliseUrl, UrlNormaliseError } from '../common/domain/url-normalise.js'
import { describeGrantScope, judgeUrl, type NetworkApproval, type UrlVerdictKind } from '../common/domain/url-verdict.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { WorkspaceError } from '../common/domain/workspace-error.js'


/**
 * 0 approved and 1 denied, like a test; 3 is the code a gated CLI call already exits with, and
 * `not listed` has its own because it is reached without asking, which a script must tell apart.
 */
const EXIT_CODES: Record<UrlVerdictKind, number> = { approved: 0, denied: 1, asks: 3, 'not listed': 4 }


/**
 * `buckle check-url`: what the network rules would answer for one URL or host, in one line. It is
 * read from this machine's configuration, the environment and the state directory, like
 * `buckle policy show`, so no node has to be running. The CLI has no session of its own, so a
 * session's approvals count only when `--session` names one. Never a tool: a probe of the policy
 * is refused to every tool with the rest of `buckle`'s own administration.
 */
export async function checkUrlCommand(input: {
  argv: string[]
  /** The workspace the command targets (D83 (4)), opened. */
  runtime: () => Promise<BuckleRuntime>
}): Promise<CliResult> {
  const parsed = parse(input.argv)
  if (!parsed) return badInput(USAGE)
  let url: URL
  try {
    url = normaliseUrl(parsed.target)
  } catch (error) {
    if (error instanceof UrlNormaliseError) return badInput(error.message)
    throw error
  }

  let runtime: BuckleRuntime
  try {
    runtime = await input.runtime()
  } catch (error) {
    if (error instanceof WorkspaceError) return badInput(error.message)
    return badInput(`Cannot open the workspace: ${messageOf(error)}`)
  }

  let approvals: NetworkApproval[]
  try {
    approvals = approvalsInEffect(runtime, parsed.session)
  } catch (error) {
    // Exit 1 would read as a denial, so state that cannot be read takes the bad-input code.
    return badInput(`Cannot read the approvals in workspace ${runtime.workspaceName()}: ${messageOf(error)}`)
  }
  const result = judgeUrl({
    url,
    ...runtime.policy.network(),
    workspaceList: runtime.policy.effective().network.allow,
    approvals,
  })
  process.stdout.write(`${result.verdict}: ${url.href} (${result.because})\n`)
  return { exitCode: EXIT_CODES[result.verdict] }
}

function parse(argv: string[]): { target: string; session?: string } | null {
  try {
    const { positionals, values } = parseArgs({ args: argv, options: { session: { type: 'string' } }, allowPositionals: true })
    if (positionals.length !== 1) return null
    return { target: positionals[0]!, session: values.session }
  } catch {
    return null
  }
}

/** Persisted approvals always count; a session's own, and its unspent `once` answers, only when named. */
function approvalsInEffect(runtime: BuckleRuntime, session?: string): NetworkApproval[] {
  const now = Date.now()
  const standing = runtime.grants.list()
    .filter(grant => grant.rule === 'network_egress' && (grant.sessionId === null || grant.sessionId === session))
    .filter(grant => !grant.expiresAt || Date.parse(grant.expiresAt) > now)
    .map(grant => ({
      subject: grant.subject,
      label: grant.sessionId === null ? describeGrantScope(grant.scope) : `${describeGrantScope(grant.scope)} of ${callerOf(grant.actor)} in session ${session}`,
      ...(grant.pattern ? { pattern: true } : {}),
    }))
  const unspent = session
    ? runtime.approvalGate.unspent(session)
      .filter(entry => entry.subject.rule === 'network_egress')
      .map(entry => ({ subject: entry.subject.subject, label: `unspent once approval for ${entry.tool} of ${callerOf(entry.actor)} in session ${session}` }))
    : []
  return [...standing, ...unspent]
}

/** The caller a session approval serves: another caller in the same session is asked again. */
function callerOf(actor: string | null | undefined): string {
  return actor ?? 'the node\'s own process'
}

/**
 * The node's configuration or state could not be read, so the runtime was never built: a corrupt
 * `policy.json`, say. Reported here rather than as the CLI's usual exit 1.
 */
export function checkUrlUnreadable(error: unknown): CliResult {
  return badInput(`Cannot read this node's policy or state, so there is no verdict: ${messageOf(error)}`)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

/** A refusal before any verdict, such as no workspace named: the bad-input code, never 1, which would read as a denial. */
export function badInput(message: string): CliResult {
  process.stderr.write(`${message}\n`)
  return { exitCode: CHECK_URL_BAD_INPUT }
}
