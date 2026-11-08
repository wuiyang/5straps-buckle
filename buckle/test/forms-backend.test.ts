import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalRequest } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { FILE_FLOOR_MARKS, PLAIN_MARKS, type PermissionDecision } from '../common/domain/permission/decision.js'
import { createApprovalRegistry, MAX_PENDING_PER_SESSION } from '../common/services/approvals/approval-registry.js'
import type { ApprovalService } from '../common/services/approvals/approval-service.js'
import type { ApprovalHost, DecisionReceipt, SkipReceipt } from '../common/types/ports/approval-backend.js'
import { SOURCES, type ApprovalSource, type FormsFace } from '../common/types/ports/approval-source.js'
import type { DecisionAudit } from '../common/types/ports/decision-audit.js'
import { createFormsBackend, MOST_FORM_ANSWERS, type FormsBackend } from '../mcp/forms-backend.js'
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
    const { tokens } = await backend.answer({ a: accepted({ approve: true, scope: 'session' }), b: accepted({ action: 'deny' }), c: accepted({ approve: true, scope: 'once' }), d: { action: 'decline' } })
    expect(tokens).toEqual(['a', 'b'])
    expect(host.decided.map(({ at: _at, ...input }) => input)).toEqual([
      { kind: 'plain', decision: { token: 'a', outcome: 'approve', scope: 'session' } },
      { kind: 'plain', decision: { token: 'b', outcome: 'deny', scope: 'once' } },
      { kind: 'plain', decision: { token: 'c', outcome: 'approve', scope: 'once' } },
    ])
  })

  it('says in the node\'s log when an answer was recorded but the lasting grant it makes is not written yet', async () => {
    const backend = forms()
    const host = fakeHost({ routed: [askFor('a'), askFor('b')], receipt: decision => (decision.decision.token === 'a' ? { status: 'applied', state: 'approved', assurance: 'local', save: 'owed' } : { status: 'repeated', state: 'approved', save: 'owed' }) })
    await backend.open(host)
    expect((await backend.answer({ a: accepted({ approve: true, scope: 'session' }), b: accepted({ approve: true, scope: 'always' }) })).tokens).toEqual(['a', 'b'])
    expect(host.logged).toEqual([
      { level: 'warn', message: 'An elicited approval was recorded, but the lasting grant it makes is not written yet, so its calls ask again until it is' },
      { level: 'warn', message: 'An elicited approval was recorded, but the lasting grant it makes is not written yet, so its calls ask again until it is' },
    ])
  })

  it('keeps the token of an answer the host answers as repeated, so the retried call spends it', async () => {
    const backend = forms()
    const host = fakeHost({ routed: [askFor('a')], receipt: () => ({ status: 'repeated', state: 'approved' }) })
    await backend.open(host)
    expect((await backend.answer({ a: accepted({ approve: true }) })).tokens).toEqual(['a'])
  })

  it('sends nothing for an answer naming no waiting ask, and, where the host\'s source answers its own caller\'s asks alone, none for another caller\'s', async () => {
    const backend = forms()
    const host = fakeHost({ routed: [askFor('a'), askFor('b', { requester: { actor: 'agent:b', sessionId: 's-1' } })], reach: { ...ONCE_ALONE, sameCaller: true } })
    await backend.open(host)
    const once = accepted({ approve: true, scope: 'once' })
    expect((await backend.answer({ a: once, b: once, gone: once }, { caller: 'agent:a' })).tokens).toEqual(['a'])
    expect(host.decided.map(input => input.decision.token)).toEqual(['a'])
    expect((await backend.answer({ a: once })).tokens).toEqual([])
    expect(host.decided).toHaveLength(1)
    expect(host.logged).toContainEqual({ level: 'info', message: 'MCP form answers named no ask waiting for their caller, so nothing was sent for them' })
  })

  it('sends each waiting ask\'s answer where the host\'s source answers any caller\'s, as a stdio host\'s does', async () => {
    const backend = forms()
    const host = fakeHost({ routed: [askFor('a'), askFor('b', { requester: { actor: null, sessionId: 's-1' } })] })
    await backend.open(host)
    const once = accepted({ approve: true, scope: 'once' })
    expect((await backend.answer({ a: once, b: once }, { caller: 'mcp-stdio' })).tokens).toEqual(['a', 'b'])
  })

  it('reads one call\'s worth of answers at most: no more than a session keeps asks waiting', async () => {
    expect(MOST_FORM_ANSWERS).toBeGreaterThanOrEqual(MAX_PENDING_PER_SESSION)
    const backend = forms()
    const tokens = Array.from({ length: MOST_FORM_ANSWERS + 5 }, (_, index) => `t${index}`)
    const host = fakeHost({ routed: tokens.map(token => askFor(token)) })
    await backend.open(host)
    await backend.answer(Object.fromEntries(tokens.map(token => [token, accepted({ approve: true, scope: 'once' })])))
    expect(host.decided).toHaveLength(MOST_FORM_ANSWERS)
    expect(host.logged).toContainEqual({ level: 'warn', message: 'An MCP form round carried more answers than one call has forms, so the rest were not read' })
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
    expect((await answering).tokens).toEqual(['a'])
    expect(sent).toEqual(['a'])
  })

  it('sends nothing to the host once it is closed', async () => {
    const backend = forms()
    const host = fakeHost({ routed: [askFor('a')] })
    await backend.open(host)
    await backend.close()
    expect(await backend.answer({ a: accepted({ approve: true }) })).toEqual({ tokens: [], unsaved: [], holds: false })
    expect(host.decided).toEqual([])
  })
})

const OWED: DecisionReceipt = { status: 'applied', state: 'approved', assurance: 'local', save: 'owed', saveError: 'permission denied' }
const SAVED: DecisionReceipt = { status: 'repeated', state: 'approved', save: 'saved' }
const UNSAVED_DENIAL: DecisionReceipt = { status: 'refused', error: { code: 'grant_unsaved', message: 'Not denied for the session: saving failed: permission denied; the call still waits', retryable: true, saveError: 'permission denied' } }
const SENDER = { caller: 'agent:a' }

/** A backend whose host answers each decision of `token` with `receipts` in turn, the last one again once they run out. */
async function savingBackend(receipts: DecisionReceipt[]) {
  const backend = forms()
  const host = fakeHost({ routed: [askFor('a')], receipt: (_decision, sent) => receipts[Math.min(sent, receipts.length) - 1]! })
  await backend.open(host)
  return { backend, host }
}

describe('the save form', () => {
  it('answers with each decision whose lasting part did not save, and draws one save form for each under save:<token>', async () => {
    const { backend } = await savingBackend([OWED])
    const answered = await backend.answer({ a: accepted({ approve: true, scope: 'session' }) }, SENDER)
    expect(answered.tokens).toEqual(['a'])
    expect(answered.unsaved).toEqual([{ decision: { token: 'a', outcome: 'approve', scope: 'session' }, unsaved: { kind: 'approval', warning: 'Approved for this call; saving it for the session failed: permission denied' }, ask: askFor('a') }])
    const drawn = backend.saveForms(answered.unsaved, SENDER)
    expect(Object.keys((drawn as { inputRequests: Record<string, unknown> }).inputRequests)).toEqual(['save:a'])
    const form = formOf(drawn, 'save:a')
    expect(form.message.split('\n')[0]).toBe('fs_write asked write_scope: /w/a (a)')
    expect(form.message).toContain('Approved for this call; saving it for the session failed: permission denied.')
    expect(form.message).toContain('cancelling leaves it to be saved later')
    expect(form.message).not.toContain('the call runs once')
    expect(form.requestedSchema.properties['save']?.enum).toEqual(['retry', 'skip'])
  })

  it('draws no save form where every decision saved', async () => {
    const { backend } = await savingBackend([SAVED])
    const answered = await backend.answer({ a: accepted({ approve: true, scope: 'session' }) })
    expect(answered.unsaved).toEqual([])
    expect(backend.saveForms(answered.unsaved)).toBeUndefined()
  })

  it('draws a save form for a lasting denial refused as unsaved, whose token the call does not spend, and whose skip denies the call once', async () => {
    const { backend, host } = await savingBackend([UNSAVED_DENIAL])
    const answered = await backend.answer({ a: accepted({ action: 'deny_session' }) }, SENDER)
    expect(answered.tokens).toEqual([])
    expect(answered.unsaved.map(item => item.unsaved.kind)).toEqual(['denial'])
    expect(formOf(backend.saveForms(answered.unsaved, SENDER), 'save:a').message).toContain('skip denies this call once instead')
    expect((await backend.answer({ 'save:a': accepted({ save: 'skip' }) }, SENDER)).tokens).toEqual(['a'])
    expect(host.decided.map(input => input.decision)).toEqual([{ token: 'a', outcome: 'deny', scope: 'session' }, { token: 'a', outcome: 'deny', scope: 'once' }])
  })

  it('sends the same decision again on a retry, with the sender, and draws no further save form when it fails again', async () => {
    const { backend, host } = await savingBackend([OWED])
    const answered = await backend.answer({ a: accepted({ approve: true, scope: 'session' }) }, SENDER)
    backend.saveForms(answered.unsaved, SENDER)
    const retried = await backend.answer({ 'save:a': accepted({ save: 'retry' }) }, SENDER)
    expect(retried).toEqual({ tokens: ['a'], unsaved: [], holds: false })
    expect(host.decided.map(({ decision, sender }) => ({ decision, sender }))).toEqual([
      { decision: { token: 'a', outcome: 'approve', scope: 'session' }, sender: SENDER },
      { decision: { token: 'a', outcome: 'approve', scope: 'session' }, sender: SENDER },
    ])
    expect(host.logged.at(-1)).toMatchObject({ level: 'warn', message: expect.stringContaining('Left unsaved') })
  })

  it.each([['a skip', accepted({ save: 'skip' })], ['a decline', { action: 'decline' }]])('skips the save on %s, with the sender', async (_name, answer) => {
    const { backend, host } = await savingBackend([OWED])
    backend.saveForms((await backend.answer({ a: accepted({ approve: true, scope: 'session' }) }, SENDER)).unsaved, SENDER)
    expect((await backend.answer({ 'save:a': answer }, SENDER)).tokens).toEqual(['a'])
    expect(host.skipped).toEqual(['a'])
    expect(host.skippedBy).toEqual([SENDER])
    expect(host.decided).toHaveLength(1)
  })

  it('leaves the save on a cancel: nothing is sent, and the call spends its once', async () => {
    const { backend, host } = await savingBackend([OWED])
    backend.saveForms((await backend.answer({ a: accepted({ approve: true, scope: 'session' }) }, SENDER)).unsaved, SENDER)
    expect((await backend.answer({ 'save:a': { action: 'cancel' } }, SENDER)).tokens).toEqual(['a'])
    expect(host.decided).toHaveLength(1)
    expect(host.skipped).toEqual([])
  })

  it('tells save answers from approval answers: a retry it drew no save form for sends nothing, nor does an approval answer carrying a save answer', async () => {
    const { backend, host } = await savingBackend([OWED])
    expect(await backend.answer({ 'save:a': accepted({ save: 'retry' }) }, SENDER)).toEqual({ tokens: [], unsaved: [], holds: false })
    expect(await backend.answer({ a: accepted({ save: 'retry' }) }, SENDER)).toEqual({ tokens: [], unsaved: [], holds: false })
    expect(host.decided).toEqual([])
    expect(host.logged).toContainEqual({ level: 'warn', message: 'A save form\'s retry came for no save form drawn for its caller, as after a restart, so nothing was retried' })
  })

  it.each([['a skip', accepted({ save: 'skip' })], ['a decline', { action: 'decline' }]])('sends %s it drew no save form for to the host, as after a restart, which holds it to the source and caller that recorded the decision', async (_name, answer) => {
    const { backend, host } = await savingBackend([OWED])
    expect((await backend.answer({ 'save:a': answer }, SENDER)).tokens).toEqual(['a'])
    expect(host.skipped).toEqual(['a'])
    expect(host.skippedBy).toEqual([SENDER])
    expect(host.decided).toEqual([])
  })

  it('reads no save answer where the host\'s source decides nothing past the call, as an HTTP host\'s, for which no save form is drawn', async () => {
    const backend = forms()
    const host = fakeHost({ routed: [askFor('a')], reach: { ...ONCE_ALONE, sameCaller: true } })
    await backend.open(host)
    const declined = Object.fromEntries(Array.from({ length: MOST_FORM_ANSWERS }, (_, index) => [`save:t${index}`, { action: 'decline' }]))
    expect(await backend.answer(declined, SENDER)).toEqual({ tokens: [], unsaved: [], holds: false })
    expect(host.skipped).toEqual([])
    expect(host.logged).toEqual([{ level: 'info', message: 'MCP save form answers came where no save form is drawn, so nothing was sent for them' }])
  })

  it('sends one call\'s worth of such skips at most', async () => {
    const { backend, host } = await savingBackend([OWED])
    await backend.answer(Object.fromEntries(Array.from({ length: MOST_FORM_ANSWERS + 5 }, (_, index) => [`save:t${index}`, accepted({ save: 'skip' })])), SENDER)
    expect(host.skipped).toHaveLength(MOST_FORM_ANSWERS)
  })

  it('sends another caller\'s skip to the host, and keeps the save form it drew for its own caller', async () => {
    const backend = forms()
    const host = fakeHost({ routed: [askFor('a')], receipt: () => OWED })
    const refusal: SkipReceipt = { status: 'refused', error: { code: 'approver_not_allowed', message: 'Only the caller that raised this ask answers it', retryable: false } }
    const skippedBy: Array<string | undefined> = []
    await backend.open({ ...host, skipSave: async (_token, sender) => { skippedBy.push(sender?.caller); return refusal } })
    backend.saveForms((await backend.answer({ a: accepted({ approve: true, scope: 'session' }) }, SENDER)).unsaved, SENDER)
    expect(await backend.answer({ 'save:a': accepted({ save: 'skip' }) }, { caller: 'agent:b' })).toEqual({ tokens: [], unsaved: [], holds: false })
    expect(skippedBy).toEqual(['agent:b'])
    expect((await backend.answer({ 'save:a': accepted({ save: 'retry' }) }, SENDER)).tokens).toEqual(['a'])
    expect(host.decided).toHaveLength(2)
  })
})

const ONCE_ALONE = { lasting: false, floor: false, sameCaller: false }
const sensitive = (token: string): ApprovalRequest => ({ ...request(token), rule: 'sensitive_path', subject: '/w/.env' })
const floorAsk = (token: string) => askFor(token, { policy: { ...askFor(token).policy, floor: true } })

describe('the forms a host\'s reach allows', () => {
  it('offers a non-floor ask once alone where the host\'s source decides nothing past the call, and names where a longer scope is approved', async () => {
    const backend = forms()
    await backend.open(fakeHost({ routed: [askFor('a')], reach: ONCE_ALONE }))
    const form = formOf(backend.forms([request('a')]), 'a')
    expect(form.requestedSchema.properties['scope']?.enum).toEqual(['once'])
    expect(form.message).toContain('this form approves it once; for the session or always, approve it at the serve terminal or with buckle approve a --scope session --workspace Site')
  })

  it('offers a credential file\'s use and its denial once alone there', async () => {
    const backend = forms()
    await backend.open(fakeHost({ routed: [askFor('s', { policy: { ...askFor('s').policy, rule: 'sensitive_path', subject: '/w/.env' } }), askFor('t', { action: undefined })], reach: ONCE_ALONE }))
    const drawn = backend.forms([sensitive('s'), sensitive('t')])
    expect(formOf(drawn, 's').requestedSchema.properties['action']?.enum).toEqual(['allow_once', 'deny'])
    expect(formOf(drawn, 't').requestedSchema.properties['action']?.enum).toEqual(['deny'])
  })

  it('draws a floor ask as a denial alone where the host\'s source approves no floor ask, naming where a person approves it', async () => {
    const backend = forms()
    await backend.open(fakeHost({ routed: [floorAsk('f')], reach: ONCE_ALONE }))
    const form = formOf(backend.forms([request('f')]), 'f')
    expect(form.requestedSchema.properties['action']?.enum).toEqual(['deny'])
    expect(form.requestedSchema.properties['approve']).toBeUndefined()
    expect(form.message).toContain('"path": "f"')
    expect(form.message).toContain('a person approves this at the node, at the serve terminal or with buckle approve f --scope session --workspace Site; this form only denies it')
  })

  it('asks the face to hold the call where a form came back dismissed whose ask a person at the node may give more than it offers', async () => {
    const backend = forms()
    const onceOnly = askFor('o', { policy: { ...askFor('o').policy, offeredScopes: ['once'] } })
    await backend.open(fakeHost({ routed: [floorAsk('f'), askFor('a'), onceOnly, askFor('n', { action: undefined })], reach: ONCE_ALONE }))
    expect((await backend.answer({ f: { action: 'decline' } })).holds).toBe(true)
    expect((await backend.answer({ a: { action: 'cancel' } })).holds).toBe(true)
    expect((await backend.answer({ o: { action: 'decline' }, n: { action: 'decline' } })).holds).toBe(false)
    expect((await backend.answer({ f: accepted({ action: 'deny' }) })).holds).toBe(false)

    const atTheNode = forms()
    await atTheNode.open(fakeHost({ routed: [floorAsk('f'), askFor('a')] }))
    expect((await atTheNode.answer({ f: { action: 'decline' }, a: { action: 'cancel' } })).holds).toBe(false)
  })

  it('says in the forms it narrows that dismissing the form holds the call for a person at the node', async () => {
    const backend = forms()
    await backend.open(fakeHost({ routed: [floorAsk('f'), askFor('a')], reach: ONCE_ALONE }))
    const drawn = backend.forms([request('f'), request('a')])
    expect(formOf(drawn, 'f').message).toContain('this form only denies it, and dismissing it holds the call for their answer')
    expect(formOf(drawn, 'a').message).toContain('then dismiss this form to hold the call for that answer')
  })

  it('draws as before where the host\'s source decides as a person at the node: every offered scope, a floor ask included', async () => {
    const backend = forms()
    await backend.open(fakeHost({ routed: [floorAsk('f'), askFor('s', { policy: { ...askFor('s').policy, rule: 'sensitive_path', subject: '/w/.env' } })] }))
    const drawn = backend.forms([request('f'), sensitive('s')])
    expect(formOf(drawn, 'f').requestedSchema.properties['scope']?.enum).toEqual(['once', 'session', 'always'])
    expect(formOf(drawn, 'f').message).not.toContain('this form')
    expect(formOf(drawn, 's').requestedSchema.properties['action']?.enum).toEqual(['allow_once', 'allow_session', 'allow_always', 'deny', 'deny_session', 'always_deny'])
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

async function opened(face: FormsFace = 'stdio') {
  const root = mkdtempSync(join(tmpdir(), 'buckle-forms-'))
  roots.push(root)
  const grants = createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: 'w-1' })
  // The forms setting on, as the owner turns it on for a workspace whose host's forms should decide.
  const registry = createApprovalRegistry(grants, join(root, 'approvals.json'), 15_000, { live: () => ({ forms: true }) })
  const heard: ApprovalSource[] = []
  const refused: Array<{ token: string; code: string }> = []
  const decisionAudit: DecisionAudit = {
    received: (decision) => {
      heard.push(decision.source)
      return { applied: () => undefined, failed: () => undefined, refused: (refusal) => { refused.push({ token: decision.token, code: refusal.code }) } }
    },
    skipReceived: (skip) => {
      heard.push(skip.source)
      return { applied: () => undefined, failed: () => undefined, refused: (refusal) => { refused.push({ token: skip.token, code: refusal.code }) } }
    },
    sessionEnded: () => undefined,
  }
  const service = approvalServiceWithTerminal({ registry, workspaceId: 'w-1', serverId: 'node-1', graceMs: 200, interaction: fixedInteraction(), decisionAudit })
  services.push(service)
  const backend = forms()
  // The host core opens the forms on, caught as the forms backend receives it.
  let host: ApprovalHost | undefined
  service.openFormsBackend({ ...backend, open: async (opener) => { host = opener; return backend.open(opener) } }, face)
  return { registry, grants, service, backend, heard, refused, host: () => host! }
}

describe('the forms host core opens', () => {
  it('decides as the forms source, whose answers count as a person\'s: a session answer is remembered', async () => {
    const { registry, grants, backend, heard, host } = await opened()
    const [asked] = (await registry.ask({ tool: 'fs_write', sessionId: 's-1', requestId: 'r-1', asks: [WRITE], call: CALL })).requests
    expect((await backend.answer({ [asked!.token]: accepted({ approve: true, scope: 'session' }) })).tokens).toEqual([asked!.token])
    expect(grants.list()).toMatchObject([{ rule: 'write_scope', subject: '/outside', scope: 'session', sessionId: 's-1' }])
    expect(heard).toEqual([{ id: 'forms', kind: 'forms' }])
    expect(host().source).toEqual({ id: 'forms', kind: 'forms' })
    expect(host().reach).toEqual({ lasting: true, floor: true, sameCaller: false })
  })

  it('tells the HTTP face\'s forms their source decides a non-floor once alone, and marks each waiting ask at the floor or not', async () => {
    const { registry, host } = await opened('http')
    await registry.ask({ tool: 'fs_delete', sessionId: 's-1', requestId: 'r-1', asks: [WRITE, DELETE], call: CALL })
    expect(host().source).toEqual(SOURCES['http-forms'])
    expect(host().reach).toEqual({ lasting: false, floor: false, sameCaller: true })
    expect(host().pending().map(ask => [ask.policy.subject, ask.policy.floor])).toEqual([['/outside', false], ['delete:/srv/data', true]])
  })

  it('skips the save of a form approval as the forms source, and refuses to skip one buckle approve recorded', async () => {
    const { registry, grants, backend, service, heard, refused, host } = await opened()
    const [formed, approved] = (await registry.ask({ tool: 'fs_write', sessionId: 's-1', requestId: 'r-1', asks: [WRITE, { ...WRITE, subject: '/other' }], call: CALL })).requests
    vi.spyOn(grants, 'grant').mockRejectedValueOnce(new Error('The grants file was busy'))
    expect((await backend.answer({ [formed!.token]: accepted({ approve: true, scope: 'session' }) })).tokens).toEqual([formed!.token])

    expect(await host().skipSave(formed!.token)).toEqual({ status: 'skipped' })
    expect(await service.decide({ source: 'cli', decision: { token: approved!.token, outcome: 'approve', scope: 'session' } })).toMatchObject({ status: 'applied', save: 'saved' })
    expect(await host().skipSave(approved!.token)).toMatchObject({ status: 'refused', error: { code: 'approver_not_allowed' } })
    expect(grants.list().map(grant => grant.subject)).toEqual(['/other'])
    expect(heard).toEqual([SOURCES.forms, SOURCES.forms, SOURCES.cli, SOURCES.forms])
    expect(refused).toEqual([{ token: approved!.token, code: 'approver_not_allowed' }])
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
    const { registry, backend, refused } = await opened()
    const [asked] = (await registry.ask({ tool: 'fs_write', sessionId: 's-1', requestId: 'r-1', asks: [WRITE] })).requests
    expect((await backend.answer({ [asked!.token]: accepted({ approve: true, scope: 'once' }) })).tokens).toEqual([])
    expect(refused).toEqual([{ token: asked!.token, code: 'incomplete_action' }])
    expect(registry.pending().map(request => request.token)).toEqual([asked!.token])
    expect((await backend.answer({ [asked!.token]: accepted({ approve: false }) })).tokens).toEqual([asked!.token])
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
