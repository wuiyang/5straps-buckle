import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalRequest, InvokeResponse, JsonValue } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reviewableArguments } from '../common/domain/redact.js'
import { runCli } from '../cli/main.js'
import { describeQuestion } from '../cli/terminal-consumer.js'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { approvalsPath, grantsPath, loadConfig, type BuckleConfig } from '../common/runtime/config.js'
import { ActionTooLargeError, ApprovalLimitError, createApprovalRegistry, MAX_ASK_BYTES, MAX_PENDING_BYTES, MAX_PENDING_BYTES_PER_ACTOR, MAX_PENDING_BYTES_PER_SESSION, type ApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import { createApprovalService, questionFor } from '../common/services/approvals/approval-service.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'

// Owner decision D17 ("i told it to show full") and the GPT review of c71dee5: a destructive command's
// session grant was keyed by its words joined with spaces and cut at 300 characters, the challenge subject
// showed the URL credentials its arguments redacted, and the shown arguments were cut past 1 KiB and 64 KiB.

const roots: string[] = []
const runtimes: BuckleRuntime[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const SECRET_A = 'tok-5ecretAlpha'
const SECRET_B = 'tok-5ecretBravo'

async function node(): Promise<{ root: string; config: BuckleConfig; runtime: BuckleRuntime; ran: string[][] }> {
  const root = mkdtempSync(join(tmpdir(), 'buckle-full-action-'))
  roots.push(root)
  mkdirSync(join(root, 'workspace'))
  const config = loadConfig({
    BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'true',
    BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_PACKS: 'fs,shell', BUCKLE_APPROVAL_TIMEOUT_MS: '1',
  })
  const runtime = await createRuntime({ config })
  runtimes.push(runtime)
  // The real shell tool judges the call; only its run is replaced, so nothing on the host is deleted or pushed.
  const ran: string[][] = []
  const tool = runtime.registry().get('shell_exec')
  const prepare = tool.prepare.bind(tool)
  vi.spyOn(tool, 'prepare').mockImplementation((args) => {
    const prepared = prepare(args)
    return { ...prepared, execute: async () => { const input = args as { command: string; args: string[] }; ran.push([input.command, ...input.args]); return 'ran' } }
  })
  return { root, config, runtime, ran }
}

let sequence = 0
function run(runtime: BuckleRuntime, command: string, args: string[]): Promise<InvokeResponse> {
  sequence += 1
  return runtime.invoke({ sessionId: 'chat-1', request: { requestId: `full-action-${sequence}`, tool: 'shell_exec', args: { command, args }, approvalTokens: [], context: { approvalWait: { mode: 'none' } } } })
}

function destructiveAsk(response: InvokeResponse): ApprovalRequest {
  if (response.outcome !== 'approval_required') throw new Error(`expected an ask, got ${response.outcome}`)
  const ask = response.approvals.find(approval => approval.rule === 'destructive_command')
  if (!ask) throw new Error('expected a destructive_command ask')
  return ask
}

async function approveSession(runtime: BuckleRuntime, response: InvokeResponse): Promise<void> {
  if (response.outcome !== 'approval_required') throw new Error(`expected an ask, got ${response.outcome}`)
  for (const approval of response.approvals) {
    const scope = approval.offeredScopes.includes('session') ? 'session' : 'once'
    expect((await runtime.approvalService.answer({ decision: { token: approval.token, approved: true, scope }, authority: 'admin' })).ok).toBe(true)
  }
}

describe('a destructive command\'s grant names exactly the command a person approved (owner decision D17)', () => {
  it('asks again for the same words split at other boundaries: a session grant for `rm -f \'a b\'` never covers `rm -f a b`', async () => {
    const { runtime, ran } = await node()
    const first = await run(runtime, 'rm', ['-f', 'a b'])
    expect(destructiveAsk(first).subject).toMatch(/^rm -f 'a b' {2}# argv sha256 [a-f0-9]{64}$/)
    await approveSession(runtime, first)
    expect(await run(runtime, 'rm', ['-f', 'a b'])).toMatchObject({ outcome: 'ok' })
    const split = await run(runtime, 'rm', ['-f', 'a', 'b'])
    expect(destructiveAsk(split).subject).toMatch(/^rm -f a b {2}# argv sha256 [a-f0-9]{64}$/)
    expect(ran).toEqual([['rm', '-f', 'a b']])
  })

  it('asks again for a command that differs only after character 300, and shows each whole', async () => {
    const { runtime, ran } = await node()
    const head = `${'d'.repeat(400)}/`
    const approved = await run(runtime, 'rm', ['-f', `${head}keep-me`])
    await approveSession(runtime, approved)
    const other = await run(runtime, 'rm', ['-f', `${head}delete-me`])
    const ask = destructiveAsk(other)
    expect(ask.subject).toContain(`${head}delete-me`)
    expect(runtime.approvalService.waiting().find(entry => entry.request.token === ask.token)?.call).toMatchObject({ arguments: { args: ['-f', `${head}delete-me`], command: 'rm' }, effects: expect.arrayContaining([`exec rm -f ${head}delete-me`]) })
    expect(ran).toEqual([])
  })

  it('keeps two different credentials apart for authorization while every approval field shows both redacted', async () => {
    const { runtime, ran, config } = await node()
    const url = (secret: string) => `https://bot:${secret}@github.com/org/repo.git`
    const first = await run(runtime, 'git', ['push', '--force', url(SECRET_A), 'main'])
    const second = await run(runtime, 'git', ['push', '--force', url(SECRET_B), 'main'])
    const [a, b] = [destructiveAsk(first), destructiveAsk(second)]
    expect(a.subject).not.toBe(b.subject)
    const display = (subject: string) => subject.replace(/ {2}# argv sha256 [a-f0-9]{64}$/, '')
    expect(display(a.subject)).toBe(display(b.subject))
    expect(display(a.subject)).toBe("git push --force 'https://[redacted]@github.com/org/repo.git' main")
    await approveSession(runtime, first)
    expect(await run(runtime, 'git', ['push', '--force', url(SECRET_A), 'main'])).toMatchObject({ outcome: 'ok' })
    expect(destructiveAsk(await run(runtime, 'git', ['push', '--force', url(SECRET_B), 'main'])).token).toEqual(expect.any(String))
    expect(ran).toEqual([['git', 'push', '--force', url(SECRET_A), 'main']])
    // The grant keeps the display and the identity, never the credential.
    expect(readFileSync(grantsPath(config), 'utf8')).not.toMatch(/5ecret/)
  })
})

describe('userinfo redaction is shared by logs and complete approval displays', () => {
  it('keeps the complete long arguments while redacting space-containing URL credentials and query values', () => {
    const prefix = 'complete-action '.repeat(10_000)
    const value = `${prefix}https://user:short password@host.example/path?token=query-secret&page=2`
    expect(reviewableArguments({ value })).toEqual({ value: `${prefix}https://[redacted]@host.example/path?token=[redacted]&page=2` })
  })

  it('redacts userinfo with spaces and its query credentials in signed arguments and the node description', async () => {
    const { runtime } = await node()
    const response = await run(runtime, 'git', ['push', '--force', 'https://user:short password@host.example/path?token=query-secret&page=2', 'main'])
    const ask = destructiveAsk(response)
    const challenge = runtime.approvalService.challengeListing().challenges.find(item => item.token === ask.token)!.challenge!
    expect(challenge.description).toContain('https://[redacted]@host.example/path?token=[redacted]&page=2')
    for (const value of [challenge, runtime.approvalService.waiting()]) {
      expect(JSON.stringify(value)).not.toContain('short password')
      expect(JSON.stringify(value)).not.toContain('query-secret')
    }
  })
})

describe('every approval field a person or a relay reads is redacted (owner decision D17)', () => {
  it('keeps a URL credential out of the subject, reason, description, arguments, effects, queue, challenge, terminal, CLI and audit', async () => {
    const { runtime, config } = await node()
    const asked = await run(runtime, 'git', ['push', '--force', `https://bot:${SECRET_A}@github.com/org/repo.git?access_token=${SECRET_B}`, 'main'])
    const ask = destructiveAsk(asked)
    const waiting = runtime.approvalService.waiting().find(entry => entry.request.token === ask.token)!
    const challenge = runtime.approvalService.challengeListing().challenges.find(entry => entry.token === ask.token)!.challenge!
    const terminal = describeQuestion({ ...ask, workspaceId: 'default', call: waiting.call! })
    const question = questionFor({ approval: ask, workspaceId: 'default', node: config.serverId, context: { correlationId: 'c', sessionId: 'chat-1', call: waiting.call! } })
    const seen: Record<string, unknown> = {
      response: asked, waiting, challenge, terminal, question, queue: readFileSync(approvalsPath(config), 'utf8'), audit: runtime.actions.read(200),
    }
    for (const [where, value] of Object.entries(seen)) expect(JSON.stringify(value), where).not.toMatch(/5ecret/)
    expect(challenge.subject).toContain('[redacted]@github.com')
    expect(JSON.stringify(challenge.arguments)).toContain('[redacted]@github.com')
    expect(challenge.description).toContain('[redacted]@github.com')
    expect(challenge.effects!.join('\n')).toContain('[redacted]@github.com')

    await runtime.approvalService.close()
    await runtime.history.close()
    runtimes.splice(runtimes.indexOf(runtime), 1)
    let stdout = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout += String(chunk); return true })
    expect((await runCli({ argv: ['approvals'], config })).exitCode).toBe(0)
    expect((await runCli({ argv: ['approvals', '--json'], config })).exitCode).toBe(0)
    vi.mocked(process.stdout.write).mockRestore()
    expect(stdout).toContain(ask.token)
    expect(stdout).toContain('[redacted]@github.com')
    expect(stdout).not.toMatch(/5ecret/)
  })

  it('redacts a reason and the requests a relay is told of, while the subject each rule asks under stays its identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-full-action-relay-'))
    roots.push(root)
    const registry = createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: root }), join(root, 'approvals.json'), root)
    const announced: ApprovalRequest[] = []
    const service = createApprovalService({ registry, workspaceId: 'default', serverId: 'node-1', graceMs: 1, interaction: async () => undefined, announce: async (requests) => { announced.push(...requests) } })
    await service.request({ sessionId: 'chat-1', requestId: 'relay', tool: 'web_fetch', wait: { mode: 'none' }, asks: [{ kind: 'ask', rule: 'network_egress', subject: 'api.example.com', reason: `Reach https://bot:${SECRET_A}@api.example.com/?token=${SECRET_B}`, offeredScopes: ['once'] }] })
    expect(announced).toHaveLength(1)
    expect(announced[0]).toMatchObject({ subject: 'api.example.com', reason: expect.stringContaining('[redacted]@api.example.com') })
    expect(JSON.stringify(announced)).not.toMatch(/5ecret/)
    expect(readFileSync(join(root, 'approvals.json'), 'utf8')).not.toMatch(/5ecret/)
    await service.close()
  })
})

describe('an action shown whole, or refused whole (owner decision D17)', () => {
  it('records a command past the old 64 KiB whole: every argument, the subject and the effect', async () => {
    const { runtime } = await node()
    const files = Array.from({ length: 60 }, (_, index) => `build/${index}-${'f'.repeat(2_000)}.o`)
    const ask = destructiveAsk(await run(runtime, 'rm', ['-f', ...files]))
    const { call } = runtime.approvalService.waiting().find(entry => entry.request.token === ask.token)!
    expect(Buffer.byteLength(JSON.stringify(call!.arguments))).toBeGreaterThan(64 * 1_024)
    expect(call!.arguments).toEqual({ args: ['-f', ...files], command: 'rm' })
    expect(ask.subject).toBe(`rm -f ${files.join(' ')}  # argv sha256 ${/[a-f0-9]{64}$/.exec(ask.subject)![0]}`)
    expect(call!.effects).toContain(`exec rm -f ${files.join(' ')}`)
    const listing = runtime.approvalService.challengeListing()
    const challenge = listing.challenges.find(entry => entry.token === ask.token)!.challenge!
    expect(challenge.arguments).toBeNull()
    expect(listing.calls[challenge.callRef!]).toMatchObject({ arguments: call!.arguments, effects: call!.effects })
    expect(challenge).not.toHaveProperty('truncated')
  })

  it('refuses a call too large to show whole before anything is asked or run, and says why', async () => {
    const { runtime, ran } = await node()
    const huge = Array.from({ length: 180 }, (_, index) => `${index}-${'h'.repeat(99_990)}`)
    const refused = await run(runtime, 'rm', ['-f', ...huge])
    expect(refused).toMatchObject({ outcome: 'error', error: { code: 'ACTION_TOO_LARGE', retryable: false, message: expect.stringContaining('nothing was asked or run') } })
    // Review M5: the size is the ask's whole record, its request and the call, and the message says so.
    expect(refused.outcome === 'error' && refused.error.message).toMatch(/one of its asks records \d+ bytes \(its request and the whole call as an approval shows it\)/)
    expect(runtime.approvalService.pending()).toEqual([])
    expect(ran).toEqual([])
  })

  it('refuses at the queue an ask whose recorded call passes the budget, writing nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-full-action-budget-'))
    roots.push(root)
    const registry = createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: root }), join(root, 'approvals.json'), root)
    const call = { arguments: { content: 'x'.repeat(MAX_ASK_BYTES) } as JsonValue, cwd: root, description: null, effects: [], complete: true as const }
    await expect(registry.ask({ tool: 'fs_write', sessionId: 'chat-1', asks: [{ kind: 'ask', rule: 'write_scope', subject: root, reason: 'outside', offeredScopes: ['once'] }], call })).rejects.toBeInstanceOf(ActionTooLargeError)
    expect(registry.pending()).toEqual([])
  })

  it('refuses a new ask while the asks waiting hold the queue\'s budget, and takes it once one is answered', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-full-action-queue-'))
    roots.push(root)
    const registry = createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: root }), join(root, 'approvals.json'), root)
    const each = Math.floor(MAX_PENDING_BYTES / 4) - 4_096
    const ask = (index: number) => registry.ask({ tool: 'fs_write', sessionId: `chat-${index}`, actor: `actor-${index}`, asks: [{ kind: 'ask', rule: 'write_scope', subject: root, reason: 'outside', offeredScopes: ['once'] }], call: { arguments: { content: String(index).repeat(each) }, cwd: root, description: null, effects: [], complete: true } })
    const tokens: string[] = []
    for (const index of [1, 2, 3, 4]) tokens.push((await ask(index)).requests[0]!.token)
    await expect(ask(5)).rejects.toThrow(/waiting in this workspace already hold \d+ bytes.*per workspace/)
    expect(await registry.resolve({ token: tokens[0]!, approved: false, scope: 'once' })).toMatchObject({ ok: true })
    expect((await ask(5)).requests).toHaveLength(1)
  })
})

// Review M5: each ask copied the whole call into approvals.json, one session could fill the workspace's 64 MiB and
// refuse every other session, every call rewrote the whole file under its lock (fs_read went from about 4 ms to about
// 530 ms), a re-send swapped in a whole call unchecked, and both refusals named the wrong thing.
describe('the approval budgets, per session, per caller and per workspace (review M5)', () => {
  function queue(): { root: string; registry: ApprovalRegistry } {
    const root = mkdtempSync(join(tmpdir(), 'buckle-full-action-budgets-'))
    roots.push(root)
    return { root, registry: createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: root }), join(root, 'approvals.json'), root) }
  }
  const write = (subject: string) => ({ kind: 'ask' as const, rule: 'write_scope' as const, subject, reason: 'outside', offeredScopes: ['once' as const] })
  const whole = (bytes: number, marker = 'x') => ({ arguments: { content: marker.repeat(bytes) } as JsonValue, cwd: '/workspace', description: null, effects: [], complete: true as const })
  const callFiles = (root: string) => { try { return readdirSync(join(root, 'approval-calls')) } catch { return [] } }

  it('takes another session\'s small ask while one session holds its share, and refuses that session\'s next one, saying so', async () => {
    const { registry } = queue()
    await registry.ask({ tool: 'fs_write', sessionId: 'loud', actor: 'agent', requestId: 'big', asks: [write('/a')], call: whole(MAX_PENDING_BYTES_PER_SESSION - 64 * 1_024) })
    await expect(registry.ask({ tool: 'fs_write', sessionId: 'loud', actor: 'agent', requestId: 'more', asks: [write('/b')], call: whole(128 * 1_024) }))
      .rejects.toThrow(/This session's approvals waiting already hold \d+ bytes and this call's asks would add \d+.*per session/)
    expect((await registry.ask({ tool: 'fs_write', sessionId: 'quiet', actor: 'agent', requestId: 'small', asks: [write('/c')], call: whole(1_000) })).requests).toHaveLength(1)
  })

  it('refuses a caller whose sessions hold its share, and still takes another caller\'s ask', async () => {
    const { registry } = queue()
    for (const session of ['one', 'two']) await registry.ask({ tool: 'fs_write', sessionId: session, actor: 'agent', asks: [write(`/${session}`)], call: whole(MAX_PENDING_BYTES_PER_ACTOR / 2 - 64 * 1_024) })
    await expect(registry.ask({ tool: 'fs_write', sessionId: 'three', actor: 'agent', asks: [write('/three')], call: whole(128 * 1_024) }))
      .rejects.toThrow(/waiting from this caller already hold \d+ bytes.*per caller/)
    expect((await registry.ask({ tool: 'fs_write', sessionId: 'four', actor: 'rings', asks: [write('/four')], call: whole(1_000) })).requests).toHaveLength(1)
  })

  it('keeps a call\'s whole body once, beside the queue, however many asks it made, and removes it with the last of them', async () => {
    const { root, registry } = queue()
    const asked = await registry.ask({ tool: 'fs_write_batch', sessionId: 'chat-1', asks: Array.from({ length: 40 }, (_, index) => write(`/dir-${index}`)), call: whole(1_024 * 1_024) })
    expect(asked.requests).toHaveLength(40)
    expect(callFiles(root)).toHaveLength(1)
    expect(statSync(join(root, 'approval-calls', callFiles(root)[0]!)).mode & 0o777).toBe(0o600)
    expect(statSync(join(root, 'approvals.json')).size).toBeLessThan(64 * 1_024)
    expect(registry.waiting().every(ask => (ask.call?.arguments as { content: string }).content.length === 1_024 * 1_024)).toBe(true)
    // Counted once: 40 asks of a 1 MiB call leave the session room for 14 MiB more.
    expect((await registry.ask({ tool: 'fs_write', sessionId: 'chat-1', asks: [write('/next')], call: whole(14 * 1_024 * 1_024) })).requests).toHaveLength(1)
    const [first, ...rest] = asked.requests
    await registry.resolve({ token: first!.token, approved: false, scope: 'once' })
    expect(callFiles(root)).toHaveLength(2)
    await registry.cancel(rest.map(request => request.token))
    expect(callFiles(root)).toHaveLength(1)
  })

  it('checks a re-send that records a call kept in part against the budgets, as a new ask is', async () => {
    const { root, registry } = queue()
    await registry.ask({ tool: 'fs_write', sessionId: 'chat-1', asks: [write('/held')], call: whole(MAX_PENDING_BYTES_PER_SESSION - 1_024 * 1_024) })
    const legacy = { tool: 'fs_write', sessionId: 'chat-1', requestId: 'legacy', fingerprint: 'fp-1', asks: [write('/legacy')] }
    await registry.ask({ ...legacy, call: { arguments: { content: 'cut...' }, cwd: '/workspace', description: null, truncated: true } })
    await expect(registry.ask({ ...legacy, call: whole(2 * 1_024 * 1_024) })).rejects.toThrow(/per session/)
    expect(registry.waiting().find(ask => ask.requestId === 'legacy')?.call).toMatchObject({ truncated: true })
    expect(callFiles(root)).toHaveLength(2)
  })

  it('leaves the queue unread and unwritten by an ordinary call, however much is waiting', async () => {
    const { config, runtime } = await node()
    writeFileSync(join(config.cwd, 'notes.md'), 'hello')
    const read = () => runtime.invoke({ sessionId: 'reader', request: { requestId: `read-${Math.random()}`, tool: 'fs_read', args: { path: 'notes.md' }, approvalTokens: [] } })
    const timed = async () => { const times: number[] = []; for (let index = 0; index < 5; index++) { const started = performance.now(); expect(await read()).toMatchObject({ outcome: 'ok' }); times.push(performance.now() - started) } return times.sort((a, b) => a - b)[2]! }
    const baseline = await timed()
    // About 60 MiB waiting, from four callers, as the review's 66 MB.
    const registry = createApprovalRegistry(createFileGrantStore({ filePath: grantsPath(config), workspace: config.cwd }), approvalsPath(config), config.cwd)
    for (const caller of ['a', 'b', 'c', 'd']) await registry.ask({ tool: 'fs_write', sessionId: `s-${caller}`, actor: caller, asks: [write(`/${caller}`)], call: whole(15 * 1_024 * 1_024, caller) })
    const before = statSync(approvalsPath(config))
    const loaded = await timed()
    const after = statSync(approvalsPath(config))
    expect([after.ino, after.mtimeMs, after.size]).toEqual([before.ino, before.mtimeMs, before.size])
    expect(before.size).toBeLessThan(64 * 1_024)
    expect(loaded).toBeLessThan(baseline * 5 + 50)
  })
})
