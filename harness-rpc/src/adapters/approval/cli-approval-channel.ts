import { createInterface } from 'node:readline/promises'
import type { ApprovalDecision, ApprovalRequest, GrantScope } from '@5straps/protocol'
import type { ApprovalChannel } from '../../ports/approval-channel.js'

/** Interactive prompt for direct terminal use. Silent when stdin is not a TTY. */
export function createCliApprovalChannel(): ApprovalChannel {
  return {
    id: 'cli',
    async request(requests) {
      if (!process.stdin.isTTY) return null
      const readline = createInterface({ input: process.stdin, output: process.stderr })
      try {
        const decisions: ApprovalDecision[] = []
        for (const request of requests) decisions.push(await promptOne(readline, request))
        return decisions
      } finally {
        readline.close()
      }
    },
  }
}

async function promptOne(
  readline: ReturnType<typeof createInterface>,
  request: ApprovalRequest,
): Promise<ApprovalDecision> {
  const choices = request.offeredScopes.map((scope, index) => `${index + 1}) ${scopeLabel(scope)}`).join('  ')
  process.stderr.write(`\n${request.tool} needs approval\n  ${request.reason}\n  subject: ${request.subject}\n`)
  const answer = (await readline.question(`  ${choices}  n) deny > `)).trim().toLowerCase()

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
