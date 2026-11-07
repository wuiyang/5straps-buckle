import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalRequest } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { FILE_FLOOR_MARKS, PLAIN_MARKS, type PermissionDecision } from '../common/domain/permission/decision.js'
import { createApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import type { ApprovalService } from '../common/services/approvals/approval-service.js'
import type { ApprovalHost, DecisionReceipt } from '../common/types/ports/approval-backend.js'
import type { ApprovalSource } from '../common/types/ports/approval-source.js'
import type { DecisionAudit } from '../common/types/ports/decision-audit.js'
import { createFormsBackend, type FormsBackend } from '../mcp/forms-backend.js'
import { askFor, fakeHost } from './support/approval-backend-kit.js'
import { approvalServiceWithTerminal, fixedInteraction } from './support/interaction.js'

// The forms backend: a stdio MCP host's forms, drawn in the call's own answer and decided through the host when the
// retried call carries them back. Its answers count as a person's, as ruling 3 of 2026-09-25 counts them.

type Form = { message: string; requestedSchema: { properties: Record<string, { enum?: string[] }> } }

const request = (token: string): ApprovalRequest => ({ token, rule: 'write_scope', subject: `/w/${token}`, reason: 'A first write in this folder', tool: 'fs_write', offeredScopes: ['once', 'session', 'always'], expiresAt: new Date(Date.now() + 600_000).toISOString() })
const accepted = (content: Record<string, unknown>) => ({ action: 'accept', content })

function forms(): FormsBackend {
  return createFormsBackend({ workspace: () => ({ id: 'w-1', name: 'Site' }), node: 'node-1', approves: () => false })
}

function formOf(result: unknown, token: string): Form {
  const shown = (result as { inputRequests: Record<string, { params?: Form } & Partial<Form>> }).inputRequests[token]!
  return (shown.params ?? shown) as Form
}

describe('the forms backend', () => {
  it('names contract version 1, decides every scope, and opens and closes more than once', async () => {
    const backend = forms()
    const host = fakeHost({ routed: [] })
    const first = await backend.open(host)
    expect(first).toEqual({ contractVersion: 1, decides: true, scopes: ['once', 'session', 'always'], cancels: false, revokes: false })
    expect(await backend.open(host)).toEqual(first)
    await backend.close()
    await expect(backend.close()).resolves.toBeUndefined()
  })

  it('declines a submit: its forms reach the host in the call\'s own answer', async () => {
    const backend = forms()
    await backend.open(fakeHost({ routed: [askFor('a')] }))
    expect(await backend.submit([askFor('a')], { signal: new AbortController().signal, resend: false })).toMatchObject({ kind: 'declined' })
  })

  it('draws one form per ask with the whole action, and a denial alone for an ask whose whole call it was not given', async () => {
    const backend = forms()
    await backend.open(fakeHost({ routed: [askFor('a'), askFor('b', { action: undefined })] }))
    const drawn = backend.forms([request('a'), request('b')])
    expect(formOf(drawn, 'a').message).toContain('"path": "a"')
    expect(formOf(drawn, 'a').requestedSchema.properties['approve']).toBeDefined()
    expect(formOf(drawn, 'b').message).toContain('recorded before this build')
    expect(formOf(drawn, 'b').requestedSchema.properties['action']?.enum).toEqual(['deny'])
  })

  it('decides each accepted answer through the host as a plain decision, and returns the tokens it recorded', async () => {
    const backend = forms()
    const host = fakeHost({ routed: [askFor('a'), askFor('b'), askFor('c')], receipt: decision => (decision.decision.token === 'c' ? REFUSED : { status: 'applied', state: 'approved', assurance: 'local' }) })
    await backend.open(host)
    const tokens = await backend.answer({ a: accepted({ approve: true, scope: 'session' }), b: accepted({ action: 'deny' }), c: accepted({ approve: true, scope: 'once' }), d: { action: 'decline' } })
    expect(tokens).toEqual(['a', 'b'])
    expect(host.decided.map(({ at: _at, ...input }) => input)).toEqual([
      { kind: 'plain', decision: { token: 'a', outcome: 'approve', scope: 'session' } },
      { kind: 'plain', decision: { token: 'b', outcome: 'deny', scope: 'once' } },
      { kind: 'plain', decision: { token: 'c', outcome: 'approve', scope: 'once' } },
    ])
  })

  it('keeps the token of an answer the host already recorded, so the retried call spends it', async () => {
    const backend = forms()
    const host = fakeHost({ routed: [], receipt: () => ({ status: 'repeated', state: 'approved' }) })
    await backend.open(host)
    expect(await backend.answer({ a: accepted({ approve: true }) })).toEqual(['a'])
  })

  it('sends every accepted answer to the host, and leaves to core whether an ask kept without its call may be approved', async () => {
    const backend = forms()
    const host = fakeHost({ routed: [askFor('a', { action: undefined })] })
    await backend.open(host)
    await backend.answer({ a: accepted({ action: 'allow_once' }) })
    expect(host.decided.map(input => input.decision)).toEqual([{ token: 'a', outcome: 'approve', scope: 'once' }])
  })

  it('waits in close for the answer it is deciding, and sends nothing more once closed', async () => {
    const backend = forms()
    const gate = Promise.withResolvers<void>()
    const sent: string[] = []
    const host: ApprovalHost = { ...fakeHost({ routed: [askFor('a'), askFor('b')] }), decide: async (input) => {
      sent.push(input.decision.token)
      await gate.promise
      return { status: 'applied', state: 'approved', assurance: 'local' }
    } }
    await backend.open(host)
    const answering = backend.answer({ a: accepted({ approve: true }), b: accepted({ approve: true }) })
    await vi.waitFor(() => expect(sent).toEqual(['a']))
    let closed = false
    const closing = backend.close().then(() => { closed = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(closed).toBe(false)
    gate.resolve()
    await closing
    expect(await answering).toEqual(['a'])
    expect(sent).toEqual(['a'])
  })

  it('sends nothing to the host once it is closed', async () => {
    const backend = forms()
    const host = fakeHost({ routed: [askFor('a')] })
    await backend.open(host)
    await backend.close()
    expect(await backend.answer({ a: accepted({ approve: true }) })).toEqual([])
    expect(host.decided).toEqual([])
  })
})

const REFUSED: DecisionReceipt = { status: 'refused', error: { code: 'scope_not_offered', message: 'refused', retryable: false } }

type Ask = Extract<PermissionDecision, { kind: 'ask' }>
const WRITE: Ask = { kind: 'ask', ...PLAIN_MARKS, rule: 'write_scope', subject: '/outside', reason: 'A first write in this folder', offeredScopes: ['once', 'session', 'always'] }
const DELETE: Ask = { kind: 'ask', ...FILE_FLOOR_MARKS, rule: 'write_scope', subject: 'delete:/srv/data', reason: 'Deleting asks a person', offeredScopes: ['once', 'session', 'always'], widerSubject: 'delete-below:/srv/data' }
const CALL = { arguments: { path: '/outside/a.md' }, cwd: '/w', description: null, effects: [], complete: true as const }

const roots: string[] = []
const services: ApprovalService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function opened() {
  const root = mkdtempSync(join(tmpdir(), 'buckle-forms-'))
  roots.push(root)
  const grants = createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: 'w-1' })
  const registry = createApprovalRegistry(grants, join(root, 'approvals.json'), 15_000)
  const heard: ApprovalSource[] = []
  const decisionAudit: DecisionAudit = { received: async (decision) => { heard.push(decision.source) }, applied: async () => {}, refused: async () => {} }
  const service = approvalServiceWithTerminal({ registry, workspaceId: 'w-1', serverId: 'node-1', graceMs: 200, interaction: fixedInteraction(), decisionAudit })
  services.push(service)
  const backend = forms()
  // The host core opens the forms on, caught as the forms backend receives it.
  let host: ApprovalHost | undefined
  service.openFormsBackend({ ...backend, open: async (opener) => { host = opener; return backend.open(opener) } })
  return { registry, grants, service, backend, heard, host: () => host! }
}

describe('the forms host core opens', () => {
  it('decides as the forms source, whose answers count as a person\'s: a session answer is remembered', async () => {
    const { registry, grants, backend, heard, host } = await opened()
    const [asked] = (await registry.ask({ tool: 'fs_write', sessionId: 's-1', requestId: 'r-1', asks: [WRITE], call: CALL })).requests
    expect(await backend.answer({ [asked!.token]: accepted({ approve: true, scope: 'session' }) })).toEqual([asked!.token])
    expect(grants.list()).toMatchObject([{ rule: 'write_scope', subject: '/outside', scope: 'session', sessionId: 's-1' }])
    expect(heard).toEqual([{ id: 'forms', kind: 'forms' }])
    expect(host().source).toEqual({ id: 'forms', kind: 'forms' })
  })

  it('takes no wider subject through the forms host, as buckle approve would grant it', async () => {
    const { registry, grants, service, host } = await opened()
    const [asked] = (await registry.ask({ tool: 'fs_delete', sessionId: 's-1', requestId: 'r-1', asks: [DELETE], call: CALL })).requests
    const decision = { token: asked!.token, outcome: 'approve' as const, scope: 'session' as const, widen: 'below' as const }
    expect(await host().decide({ kind: 'plain', decision })).toEqual({ status: 'refused', error: { code: 'scope_forbidden', message: 'Only the node\'s terminal and buckle approve grant a folder and its subfolders', retryable: false } })
    expect(grants.list()).toEqual([])
    expect(await service.decide({ source: 'cli', decision })).toMatchObject({ status: 'applied', granted: 'delete-below:/srv/data' })
  })

  it('leaves the whole-action check to core: an approval of an ask kept without its call is refused, and its denial applies', async () => {
    const { registry, backend } = await opened()
    const [asked] = (await registry.ask({ tool: 'fs_write', sessionId: 's-1', requestId: 'r-1', asks: [WRITE] })).requests
    expect(await backend.answer({ [asked!.token]: accepted({ approve: true, scope: 'once' }) })).toEqual([])
    expect(registry.pending().map(request => request.token)).toEqual([asked!.token])
    expect(await backend.answer({ [asked!.token]: accepted({ approve: false }) })).toEqual([asked!.token])
    expect(registry.pending()).toEqual([])
  })

  it('hands the forms each waiting ask whole, grouped by its call, and none whose whole call was not kept', async () => {
    const { registry, backend } = await opened()
    const recorded = (await registry.ask({ tool: 'fs_write', sessionId: 's-1', requestId: 'r-1', asks: [WRITE, { ...WRITE, subject: '/other' }], call: { ...CALL, description: 'Write a.md', effects: ['write /outside/a.md'] } })).requests
    const drawn = backend.forms(recorded)
    const [first, second] = recorded.map(item => formOf(drawn, item.token))
    expect(first!.message).toContain('"path": "/outside/a.md"')
    expect(first!.message).toContain('this call makes 2, each decided on its own')
    expect(second!.message).toContain(`its call is the one shown whole above with ${recorded[0]!.token}`)
  })
})
