import { createInterface } from 'node:readline/promises'
import type { ApprovalDecision, ApprovalRequest, GrantScope } from '@5straps/protocol'
import { createSerialQueue } from '../../domain/serial-queue.js'
import type { ApprovalChannel } from '../../ports/approval-channel.js'

/**
 * Interactive prompt for direct terminal use. Silent when stdin is not a TTY.
 *
 * Questions are queued and answered one at a time. A terminal cannot be navigated, so two
 * prompts sharing stdin would interleave their text and race for the same keystroke: a request
 * arriving while someone is reading could take the answer meant for the one they were shown.
 * Serialising it means the answer always belongs to the question on screen.
 */
export function createCliApprovalChannel(): ApprovalChannel {
  const queue = createSerialQueue()

  return {
    id: 'cli',
    request(requests, signal) {
      if (!process.stdin.isTTY) return Promise.resolve(null)
      return queue(() => ask(requests, signal))
    },
  }
}

async function ask(requests: ApprovalRequest[], signal?: AbortSignal): Promise<ApprovalDecision[] | null> {
  // The wait for our turn may have outlasted the grace period, or another route may have answered.
  if (signal?.aborted) return null

  const readline = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const decisions: ApprovalDecision[] = []
    for (const request of requests) decisions.push(await promptOne(readline, request, signal))
    return decisions
  } catch {
    // Aborted mid-question: the decision came from somewhere else, so this one is moot.
    return null
  } finally {
    readline.close()
  }
}

async function promptOne(
  readline: ReturnType<typeof createInterface>,
  request: ApprovalRequest,
  signal?: AbortSignal,
): Promise<ApprovalDecision> {
  const choices = request.offeredScopes.map((scope, index) => `${index + 1}) ${scopeLabel(scope)}`).join('  ')
  process.stderr.write(`\n${request.tool} needs approval\n  ${request.reason}\n  subject: ${request.subject}\n`)
  const answer = (await readline.question(`  ${choices}  n) deny > `, { signal })).trim().toLowerCase()

  const chosenIndex = Number.parseInt(answer, 10) - 1
  const scope = request.offeredScopes[chosenIndex]
  if (!scope) return { token: request.token, approved: false, scope: 'once' }
  return { token: request.token, approved: true, scope }
}

function scopeLabel(scope: GrantScope): string {
  if (scope === 'once') return 'allow once'
  if (scope === 'session') return 'allow this session'
  return 'always allow'
}
