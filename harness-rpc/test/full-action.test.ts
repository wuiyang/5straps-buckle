import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalRequest, InvokeResponse, JsonValue } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../cli/main.js'
import { describeQuestion } from '../cli/terminal-consumer.js'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { approvalsPath, grantsPath, loadConfig, type BuckleConfig } from '../common/runtime/config.js'
import { ActionTooLargeError, ApprovalLimitError, createApprovalRegistry, MAX_ASK_BYTES, MAX_PENDING_BYTES } from '../common/services/approvals/approval-registry.js'
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

describe('every approval field a person or a relay reads is redacted (owner decision D17)', () => {
  it('keeps a URL credential out of the subject, reason, description, arguments, effects, queue, challenge, terminal, CLI and audit', async () => {
    const { runtime, config } = await node()
    const asked = await run(runtime, 'git', ['push', '--force', `https://bot:${SECRET_A}@github.com/org/repo.git?access_token=${SECRET_B}`, 'main'])
    const ask = destructiveAsk(asked)
    const waiting = runtime.approvalService.waiting().find(entry => entry.request.token === ask.token)!
    const challenge = runtime.approvalService.challenges().find(entry => entry.token === ask.token)!.challenge!
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
    const challenge = runtime.approvalService.challenges().find(entry => entry.token === ask.token)!.challenge!
    expect(challenge.arguments).toEqual(call!.arguments)
    expect(challenge).not.toHaveProperty('truncated')
  })

  it('refuses a call too large to show whole before anything is asked or run, and says why', async () => {
    const { runtime, ran } = await node()
    const huge = Array.from({ length: 180 }, (_, index) => `${index}-${'h'.repeat(99_990)}`)
    const refused = await run(runtime, 'rm', ['-f', ...huge])
    expect(refused).toMatchObject({ outcome: 'error', error: { code: 'ACTION_TOO_LARGE', retryable: false, message: expect.stringContaining('nothing was asked or run') } })
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
    const ask = (index: number) => registry.ask({ tool: 'fs_write', sessionId: `chat-${index}`, asks: [{ kind: 'ask', rule: 'write_scope', subject: root, reason: 'outside', offeredScopes: ['once'] }], call: { arguments: { content: String(index).repeat(each) }, cwd: root, description: null, effects: [], complete: true } })
    const tokens: string[] = []
    for (const index of [1, 2, 3, 4]) tokens.push((await ask(index)).requests[0]!.token)
    await expect(ask(5)).rejects.toBeInstanceOf(ApprovalLimitError)
    expect(await registry.resolve({ token: tokens[0]!, approved: false, scope: 'once' })).toMatchObject({ ok: true })
    expect((await ask(5)).requests).toHaveLength(1)
  })
})
