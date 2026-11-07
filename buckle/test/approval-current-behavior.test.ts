import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RequestCli } from '@5straps/runtime'
import type { InvokeResponse, JsonObject } from '@5straps/protocol'
import { challengeBytes } from '@5straps/protocol/signed-request'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RECORDED_BEFORE_NOTE } from '../common/domain/approval/decision-guard.js'
import { commandMarks, FILE_FLOOR_MARKS, PLAIN_MARKS } from '../common/domain/permission/decision.js'
import type { PermissionEngine } from '../common/domain/permission/engine.js'
import { withDangerouslyAllow } from '../common/domain/permission/rules/dangerously-allow.js'
import { approvalsPath, grantsPath } from '../common/runtime/config.js'
import { NO_INTERACTION, type Interaction } from '../common/services/approvals/interaction.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { fixedInteraction } from './support/interaction.js'
import { captureWebhook } from './support/webhook.js'
import { configFromEnvironment } from './support/workspace-config.js'

// Today's approval behaviors, driven through the invoker and the approval service, so each slice of the approval backend
// design shows what it keeps and what it changes. The stdio form's owner authority is pinned in mcp-elicitation.test.ts.

const roots: string[] = []
const runtimes: BuckleRuntime[] = []
const closers: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  for (const close of closers.splice(0)) await close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** No terminal, a hold only while this process asks: a gated call answers approval_required at once. */
const NOBODY: Interaction = { requestCli: NO_INTERACTION.requestCli, hold: 'prompt' }

/** A serve terminal that answers each question with the next choice, then denies every later one. */
function terminal(choices: string[]): Interaction & { asked: string[] } {
  const asked: string[] = []
  const requestCli: RequestCli = async (request) => {
    asked.push(request.id)
    return { status: 'answered', requestId: request.id, answer: { choice: choices[asked.length - 1] ?? 'deny' } }
  }
  return { requestCli, hold: 'grace', asked }
}

async function node(input: { interaction?: Interaction; webhook?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-current-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(join(workspace, 'one'), { recursive: true })
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  const webhook = input.webhook ? await captureWebhook() : undefined
  if (webhook) closers.push(webhook.close)
  const config = configFromEnvironment({
    BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_AUTH_TOKEN: 'current-agent-token', BUCKLE_ADMIN_TOKEN: 'current-admin-token',
    BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '60000', BUCKLE_DELETE_IN_WORKSPACE: 'ask',
    ...(webhook ? { BUCKLE_APPROVAL_WEBHOOK: webhook.url } : {}),
  })
  const runtime = await createRuntime({ config, interaction: fixedInteraction(input.interaction ?? NOBODY) })
  runtimes.push(runtime)
  let sequence = 0
  const call = (tool: string, args: JsonObject, options: { sessionId?: string; requestId?: string; tokens?: string[] } = {}): Promise<InvokeResponse> =>
    runtime.invoke({ request: { requestId: options.requestId ?? `call-${++sequence}`, tool, args, approvalTokens: options.tokens ?? [] }, sessionId: options.sessionId ?? 's' })
  const answer = (token: string, decision: { approved?: boolean; scope?: 'once' | 'session' | 'always'; subject?: string } = {}, authority: 'admin' | 'agent' = 'admin') =>
    runtime.approvalService.answer({ decision: { token, approved: decision.approved ?? true, scope: decision.scope ?? 'once', ...(decision.subject === undefined ? {} : { subject: decision.subject }) }, authority })
  return { root, workspace, config, runtime, webhook, call, answer, folder: runtime.paths().root }
}

const tokensOf = (response: InvokeResponse) => (response.outcome === 'approval_required' ? response.approvals.map(approval => approval.token) : [])

describe('a serve terminal answer', () => {
  it('grants the folder for the session with no expiry, tells the webhook, and writes no decision entry to the audit log', async () => {
    const asker = terminal(['session'])
    const { runtime, webhook, call, folder } = await node({ interaction: asker, webhook: true })

    expect(await call('fs_write', { path: 'one/a.md', content: 'a' })).toMatchObject({ outcome: 'ok' })
    expect(await call('fs_write', { path: 'one/b.md', content: 'b' })).toMatchObject({ outcome: 'ok' })

    expect(asker.asked).toHaveLength(1)
    expect(runtime.grants.list()).toEqual([expect.objectContaining({ rule: 'write_scope', subject: join(folder, 'one'), scope: 'session', sessionId: 's', expiresAt: null })])
    await vi.waitFor(() => expect(webhook!.notices.filter(notice => notice.event === 'answered')).toEqual([expect.objectContaining({ event: 'answered', scope: 'session' })]))
    const entries = runtime.actions.read(50)
    expect(new Set(entries.map(entry => entry.tool))).toEqual(new Set(['fs_write']))
    expect(entries.filter(entry => entry.event === 'result').map(entry => [entry.outcome, entry.asked, entry.approvedBy])).toEqual([
      ['ok', ['write_scope'], ['write_scope']],
      ['ok', undefined, ['write_scope']],
    ])
  })

  it('approving once runs the call once, and denying the next refuses it as declined', async () => {
    const asker = terminal(['once', 'deny'])
    const { runtime, call } = await node({ interaction: asker })

    expect(await call('fs_write', { path: 'one/a.md', content: 'a' })).toMatchObject({ outcome: 'ok' })
    expect(await call('fs_write', { path: 'one/a.md', content: 'again' })).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('Approval was declined') } })

    expect(asker.asked).toHaveLength(2)
    expect(runtime.grants.list()).toEqual([])
    expect(runtime.approvals.unspent('s')).toEqual([])
  })
})

describe('an ask nobody is at a terminal for', () => {
  it('answers approval_required at once; a once answered later is spent by the retry without its token, in that session alone', async () => {
    const { runtime, call, answer } = await node()
    const asked = await call('fs_write', { path: 'one/a.md', content: 'a' })
    expect(asked).toMatchObject({ outcome: 'approval_required', approvals: [{ rule: 'write_scope', offeredScopes: ['once', 'session', 'always'] }] })
    expect(await answer(tokensOf(asked)[0]!)).toMatchObject({ ok: true, asked: { rule: 'write_scope' } })

    expect((await call('fs_write', { path: 'one/a.md', content: 'a' }, { sessionId: 'other' })).outcome).toBe('approval_required')
    expect(await call('fs_write', { path: 'one/a.md', content: 'a' })).toMatchObject({ outcome: 'ok' })
    expect((await call('fs_write', { path: 'one/a.md', content: 'a' })).outcome).toBe('approval_required')
    expect(runtime.grants.list()).toEqual([])
  })

  it('keeps its ask under the workspace folder in the ledger, and its grant under the workspace id', async () => {
    const { runtime, config, call, answer } = await node()
    const asked = await call('fs_write', { path: 'one/a.md', content: 'a' })
    const ledger = JSON.parse(readFileSync(approvalsPath(config), 'utf8')) as { pending: Array<{ workspace: string }> }
    expect(ledger.pending.map(entry => entry.workspace)).toEqual([config.cwd])
    expect(config.cwd).not.toBe(runtime.workspaceId)
    expect(await answer(tokensOf(asked)[0]!, { scope: 'always' })).toMatchObject({ ok: true })
    const grants = JSON.parse(readFileSync(grantsPath(config), 'utf8')) as { grants: Array<{ workspace: string }> }
    expect(grants.grants.map(grant => grant.workspace)).toEqual([runtime.workspaceId])
  })
})

describe('a delete at the file floor', () => {
  it('offers always, and an always grant clears the next delete in that folder without asking', async () => {
    const { runtime, workspace, call, answer, folder } = await node()
    writeFileSync(join(workspace, 'one', 'a.txt'), 'a')
    writeFileSync(join(workspace, 'one', 'b.txt'), 'b')
    await runtime.grants.grant({ sessionId: 's', rule: 'write_scope', subject: folder, scope: 'session' })

    const asked = await call('fs_delete', { paths: ['one/a.txt'] }, { requestId: 'delete-a' })
    expect(asked).toMatchObject({ outcome: 'approval_required', approvals: [{ rule: 'write_scope', subject: `delete:${join(folder, 'one')}`, offeredScopes: ['once', 'session', 'always'] }] })
    expect(await answer(tokensOf(asked)[0]!, { scope: 'always' })).toMatchObject({ ok: true })

    expect(await call('fs_delete', { paths: ['one/a.txt'] }, { requestId: 'delete-a', tokens: tokensOf(asked) })).toMatchObject({ outcome: 'ok' })
    expect(await call('fs_delete', { paths: ['one/b.txt'] })).toMatchObject({ outcome: 'ok' })
    expect(runtime.grants.list().filter(grant => grant.subject.startsWith('delete:'))).toEqual([expect.objectContaining({ subject: `delete:${join(folder, 'one')}`, scope: 'always', sessionId: null })])
  })
})

describe('the checks an answer meets', () => {
  async function waitingAsk(path = 'one/a.md') {
    const context = await node()
    const asked = await context.call('fs_write', { path, content: 'a' })
    return { ...context, token: tokensOf(asked)[0]! }
  }

  it.each([
    ['an unknown token', (token: string) => ({ token: `${token}-other`, approved: true, scope: 'once' as const }), 'Approval token is unknown or expired'],
    ['a lasting denial of a write', (token: string) => ({ token, approved: false, scope: 'session' as const }), 'Persistent denials are supported only for sensitive files'],
    ['another subject than the ask offers', (token: string) => ({ token, approved: true, scope: 'session' as const, subject: '/elsewhere' }), 'not /elsewhere'],
  ])('refuses %s', async (_name, decision, reason) => {
    const { runtime, token } = await waitingAsk()
    expect(await runtime.approvalService.answer({ decision: decision(token), authority: 'admin' })).toMatchObject({ ok: false, reason: expect.stringContaining(reason) })
    expect(runtime.approvalService.pending().map(request => request.token)).toEqual([token])
  })

  it('refuses a lasting answer from the agent authority, and a host pattern on a write', async () => {
    const { runtime, token } = await waitingAsk()
    expect(await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'session' }, authority: 'agent' })).toEqual({ ok: false, reason: 'Only the admin credential writes an approval that outlives the call' })
    expect(await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'session' }, authority: 'agent', widenTo: '*.example.com' })).toEqual({ ok: false, reason: 'Only the admin credential writes an approval that outlives the call' })
    expect(await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'once' }, authority: 'admin', widenTo: '*.example.com' })).toEqual({ ok: false, reason: 'A once approval covers one call to the host that asked; widen a session or always approval instead' })
    expect(await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'session' }, authority: 'admin', widenTo: '*.example.com' })).toMatchObject({ ok: false, reason: expect.stringContaining('--host widens a network approval only; this one is write_scope') })
  })

  it('refuses a challenge other than the ask\'s, and a signed once past its proof deadline', async () => {
    const { runtime, token } = await waitingAsk()
    expect(await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'once' }, authority: 'admin', challenge: 'f'.repeat(64) })).toEqual({ ok: false, reason: 'The decision names another challenge than this ask\'s: fetch the challenge again and decide on what it shows' })
    expect(await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'once' }, authority: 'admin', consumeNotAfter: Date.now() - 1 })).toEqual({ ok: false, reason: 'Signed approval expired before tool admission; sign a fresh decision over the current challenge' })
  })

  it('accepts the ask\'s own challenge, signed with the workspace\'s name or without it', async () => {
    const { runtime, call } = await node()
    const tokens = [await call('fs_write', { path: 'one/a.md', content: 'a' }), await call('fs_write', { path: 'one/b.md', content: 'b' })].map(response => tokensOf(response)[0]!)
    for (const [index, workspaceName] of [false, true].entries()) {
      const challenge = runtime.approvalService.challengeListing({ workspaceName }).challenges.find(entry => entry.token === tokens[index])!.challenge!
      expect(challenge.workspaceName === undefined).toBe(!workspaceName)
      expect(await runtime.approvalService.answer({ decision: { token: tokens[index]!, approved: true, scope: 'once' }, authority: 'admin', challenge: challengeBytes(challenge).digest })).toMatchObject({ ok: true })
    }
  })

  it('answers the same decision again as repeated, and refuses a different one', async () => {
    const { runtime, token } = await waitingAsk()
    expect(await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'once' }, authority: 'admin' })).toMatchObject({ ok: true })
    expect(await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'once' }, authority: 'admin' })).toMatchObject({ ok: true, repeated: true, asked: { rule: 'write_scope' } })
    expect(await runtime.approvalService.answer({ decision: { token, approved: false, scope: 'once' }, authority: 'admin' })).toEqual({ ok: false, reason: 'Approval already has a different decision' })
  })

  it('refuses a scope the ask does not offer, and any approval of an ask recorded without its whole call', async () => {
    const { runtime } = await node()
    const [secret] = (await runtime.approvals.ask({ tool: 'fs_read', sessionId: 's', asks: [{ kind: 'ask', rule: 'sensitive_path', subject: '/workspace/.env', reason: 'WARNING', offeredScopes: ['once'], ...PLAIN_MARKS }], call: { arguments: {}, cwd: '/workspace', description: null, complete: true } })).requests
    expect(await runtime.approvalService.answer({ decision: { token: secret!.token, approved: true, scope: 'session' }, authority: 'admin' })).toEqual({ ok: false, reason: 'Scope session is not offered for this approval' })
    const [bare] = (await runtime.approvals.ask({ tool: 'fs_write', sessionId: 's', asks: [{ kind: 'ask', rule: 'write_scope', subject: '/outside', reason: 'outside', offeredScopes: ['once'], ...PLAIN_MARKS }] })).requests
    expect(await runtime.approvalService.answer({ decision: { token: bare!.token, approved: true, scope: 'once' }, authority: 'admin' })).toEqual({ ok: false, reason: `This ask was ${RECORDED_BEFORE_NOTE}` })
    expect(await runtime.approvalService.answer({ decision: { token: bare!.token, approved: false, scope: 'once' }, authority: 'admin' })).toMatchObject({ ok: true })
  })
})

describe('the setup face', () => {
  it('denies through an unsigned decision and never approves through one', async () => {
    const { runtime, call } = await node()
    const [first, second] = [await call('fs_write', { path: 'one/a.md', content: 'a' }), await call('fs_write', { path: 'one/b.md', content: 'b' })].map(response => tokensOf(response)[0]!)
    expect(await runtime.approvalService.decideSealed({ body: { token: first, approved: true, scope: 'once' } })).toEqual({
      status: 'rejected', reason: 'Approval requires an enrolled device key: review and confirm with buckle client approve', decided: { token: first, approved: true, scope: 'once' },
    })
    expect(await runtime.approvalService.decideSealed({ body: { token: second, approved: false, scope: 'once' } })).toMatchObject({ status: 'answered', decided: { token: second, approved: false, scope: 'once', rule: 'write_scope' } })
    expect(runtime.approvalService.pending().map(request => request.token)).toEqual([first])
  })

  it('withdraws a call by token, naming the asks withdrawn and the onces dropped', async () => {
    const { runtime, call, answer } = await node()
    const asked = await call('fs_write_batch', { files: [{ path: 'one/a.md', content: 'a' }, { path: 'b.md', content: 'b' }] })
    const [first, second] = tokensOf(asked)
    expect(await answer(first!)).toMatchObject({ ok: true })
    expect(await runtime.approvalService.withdrawCall({ token: second! })).toEqual({ withdrawn: [second], dropped: [first], selector: { token: second } })
    expect(runtime.approvals.unspent('s')).toEqual([])
  })
})

describe('the dangerously-allow switch', () => {
  it('lifts floor asks, a delete\'s and a command\'s, and leaves a restore to a person', () => {
    const asks = [
      { kind: 'ask' as const, rule: 'destructive_command' as const, subject: 'rm -rf build', reason: 'floor', offeredScopes: ['once' as const, 'session' as const], cause: 'floor' as const, ...commandMarks('floor') },
      { kind: 'ask' as const, rule: 'write_scope' as const, subject: 'delete:/work/project/src', reason: 'floor', offeredScopes: ['once' as const, 'session' as const, 'always' as const], ...FILE_FLOOR_MARKS },
      { kind: 'ask' as const, rule: 'write_scope' as const, subject: 'restore:change-1', reason: 'floor', offeredScopes: ['once' as const], ...FILE_FLOOR_MARKS },
    ]
    const asking: PermissionEngine = { evaluate: () => ({ kind: 'ask', asks }) }
    const lifted = withDangerouslyAllow(asking, { level: () => 'command', root: () => '/work/project' }).evaluate({ tool: 'shell_exec', effects: [], grants: { subjectsFor: () => [] } })
    expect(lifted).toEqual({ kind: 'ask', asks: [asks[2]] })
    const without = withDangerouslyAllow({ evaluate: () => ({ kind: 'ask', asks: asks.slice(0, 2) }) }, { level: () => 'command', root: () => '/work/project' }).evaluate({ tool: 'shell_exec', effects: [], grants: { subjectsFor: () => [] } })
    expect(without).toEqual({ kind: 'allow', allowedBy: ['dangerously_allow:command:destructive_command:rm -rf build', 'dangerously_allow:command:write_scope:delete:/work/project/src'] })
  })
})
