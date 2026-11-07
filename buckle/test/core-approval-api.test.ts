import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { FILE_FLOOR_MARKS, PLAIN_MARKS, type PermissionDecision } from '../common/domain/permission/decision.js'
import { createApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import type { ApprovalService } from '../common/services/approvals/approval-service.js'
import { approvalServiceWithTerminal, fixedInteraction } from './support/interaction.js'

// The core approval API: what `buckle approve`, `buckle approvals --watch`, and `--approve-if-safe` decide through. A
// client names its source by tag; core holds that source, and the decision guard checks the decision as any backend's.

type Ask = Extract<PermissionDecision, { kind: 'ask' }>

const CALL = { arguments: { paths: ['/srv/data/reports/old.csv'] }, cwd: '/workspace', description: 'Delete 1 file', effects: ['delete /srv/data/reports/old.csv'], complete: true as const }
const WIDE: Ask = { kind: 'ask', ...FILE_FLOOR_MARKS, rule: 'write_scope', subject: 'delete:/srv/data/reports', reason: 'Deleting /data/reports/old.csv asks a person', offeredScopes: ['once', 'session', 'always'], widerSubject: 'delete-below:/srv/data/reports' }
const COMMAND: Ask = { kind: 'ask', destructive: true, floor: false, rule: 'destructive_command', subject: 'python3 build.py', reason: 'Runs an interpreter', offeredScopes: ['once', 'session'] }
const HOST: Ask = { kind: 'ask', ...PLAIN_MARKS, rule: 'network_egress', subject: 'api.example.com', reason: 'Reaches a host the policy does not name', offeredScopes: ['once', 'session', 'always'] }

const roots: string[] = []
const services: ApprovalService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function asked(ask: Ask) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-core-api-'))
  roots.push(root)
  const grants = createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: 'w-1' })
  const registry = createApprovalRegistry(grants, join(root, 'approvals.json'), 15_000)
  const service = approvalServiceWithTerminal({ registry, workspaceId: 'w-1', serverId: 'node-1', graceMs: 200, interaction: fixedInteraction() })
  services.push(service)
  const [request] = (await registry.ask({ tool: 'fs_delete', sessionId: 's-1', requestId: 'r-1', asks: [ask], call: CALL })).requests
  const ledger = () => JSON.parse(readFileSync(join(root, 'approvals.json'), 'utf8')) as { once: Array<Record<string, unknown>> }
  return { service, registry, grants, token: request!.token, ledger }
}

describe('the core approval API', () => {
  it('records an --approve-if-safe pass as the judge\'s once, at relayed, bound to the code it rated', async () => {
    const { service, token, ledger } = await asked(COMMAND)
    const receipt = await service.decide({ source: 'judge', decision: { token, outcome: 'approve', scope: 'once' }, rater: 'thorough:openai:gpt-test', code: { key: 'c'.repeat(64), allowed: true } })
    expect(receipt).toEqual({ status: 'applied', state: 'approved', assurance: 'relayed', asked: { rule: 'destructive_command', subject: 'python3 build.py' } })
    expect(ledger().once).toMatchObject([{ token, decidedBy: 'judge:thorough:openai:gpt-test', code: { key: 'c'.repeat(64), allowed: true } }])
  })

  it('holds the judge to one call', async () => {
    const { service, token, grants } = await asked(COMMAND)
    const receipt = await service.decide({ source: 'judge', decision: { token, outcome: 'approve', scope: 'session' }, rater: 'thorough:openai:gpt-test' })
    expect(receipt).toMatchObject({ status: 'refused', error: { code: 'assurance_too_low', retryable: false } })
    expect(grants.list()).toEqual([])
  })

  it('grants the ask\'s folder and its subfolders where a person at the node widens below', async () => {
    const { service, token, grants } = await asked(WIDE)
    const receipt = await service.decide({ source: 'cli', decision: { token, outcome: 'approve', scope: 'session', widen: 'below' } })
    expect(receipt).toEqual({ status: 'applied', state: 'approved', assurance: 'local', asked: { rule: 'write_scope', subject: 'delete:/srv/data/reports' }, granted: 'delete-below:/srv/data/reports' })
    expect(grants.list()).toMatchObject([{ rule: 'write_scope', subject: 'delete-below:/srv/data/reports', scope: 'session', sessionId: 's-1' }])
  })

  it('reads the wider subject from the ledger, so a widening sent again once its ask left the queue repeats it', async () => {
    const { service, token } = await asked(WIDE)
    const decision = { token, outcome: 'approve' as const, scope: 'always' as const, widen: 'below' as const }
    expect(await service.decide({ source: 'cli', decision })).toMatchObject({ status: 'applied', granted: 'delete-below:/srv/data/reports' })
    expect(service.waitingAsk(token)).toBeUndefined()
    expect(await service.decide({ source: 'cli', decision })).toEqual({ status: 'repeated', state: 'approved', asked: { rule: 'write_scope', subject: 'delete:/srv/data/reports' } })
    expect(await service.decide({ source: 'cli', decision: { token, outcome: 'approve', scope: 'always' } })).toMatchObject({ status: 'refused', error: { code: 'conflicting_decision' } })
  })

  it('refuses a widening below where the ask offers no wider subject', async () => {
    const { widerSubject: _none, ...narrow } = WIDE
    const { service, token, grants } = await asked(narrow)
    expect(await service.decide({ source: 'cli', decision: { token, outcome: 'approve', scope: 'session', widen: 'below' } })).toEqual({ status: 'refused', error: { code: 'scope_not_offered', message: 'This ask has no wider subject to grant', retryable: false } })
    expect(grants.list()).toEqual([])
  })

  it('widens a network approval to the host pattern buckle approve --host names', async () => {
    const { service, token, grants } = await asked(HOST)
    const receipt = await service.decide({ source: 'cli', decision: { token, outcome: 'approve', scope: 'always' }, hostPattern: '*.example.com' })
    expect(receipt).toMatchObject({ status: 'applied', widened: { pattern: '*.example.com', askedBy: 'api.example.com' } })
    expect(grants.list()).toMatchObject([{ rule: 'network_egress', subject: '*.example.com', pattern: true, scope: 'always' }])
  })

  it('says why the decision guard refused, in its own words', async () => {
    const { service } = await asked(HOST)
    expect(await service.decide({ source: 'cli', decision: { token: 'no-such-token', outcome: 'deny', scope: 'once' } })).toEqual({ status: 'refused', error: { code: 'unknown_ask', message: 'Approval token is unknown or expired', retryable: false } })
  })
})
