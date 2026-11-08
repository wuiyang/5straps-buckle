import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyWorkspacePolicy } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FLOOR_WARNING } from '../common/types/ports/approval-backend.js'
import { CODE_CHANGED_REASON } from '../common/domain/permission/judged.js'
import { approvalsPath, loadConfig } from '../common/runtime/config.js'
import { CHANGES_DIRECTORY } from '../common/services/judge/call-forms.js'
import { withMount } from '../common/services/workspaces/workspace-settings.js'
import { CREDENTIAL_HIDDEN, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import type { DecisionClaim } from '../common/domain/approval/decision-guard.js'
import { SOURCES } from '../common/types/ports/approval-source.js'
import { runCli } from './support/cli.js'
import { byName, idOf, workspacesOf } from './support/workspaces.js'
import { auditEntries } from './support/action-log-writer.js'

// `buckle approvals judge <token> [--approve-if-safe]` (D91, addendum C): the decision AI rates one waiting interpreter
// ask at the owner's request, through the real OpenAI-compatible adapter against a local stand-in at the node's
// BUCKLE_JUDGE_BASE_URL, and the verdict is printed beside the whole action; a safe verdict at 0.8 or above approves the
// ask once where the owner asked for that, with the judge named as who decided.

// Each decision's source and scope, as the registry hands them to the decision guard.
const claims = vi.hoisted(() => [] as Array<{ source: unknown; scope: string }>)
vi.mock('../common/domain/approval/decision-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../common/domain/approval/decision-guard.js')>()
  return { ...actual, screenDecision: (claim: DecisionClaim) => { claims.push({ source: claim.source, scope: claim.decision.scope }); return actual.screenDecision(claim) } }
})

const KEY = 'sk-on-request-fixture-0123456789'
const QUICK_KEY = 'ts-on-request-fixture-0123456789'
const roots: string[] = []
const servers: Server[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  claims.length = 0
  for (const server of servers.splice(0)) await new Promise(resolve => server.close(resolve))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** An OpenAI-compatible endpoint that rates every command as `answer` says, echoing the command it was shown. */
async function standIn(answer: { level: string; confidence: number } | { status: number }) {
  const seen: Array<{ authorization: string | undefined; user: { command: string; files: Array<{ path: string; content: string }> } }> = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      const parsed = JSON.parse(body) as { messages: Array<{ content: string }> }
      const user = JSON.parse(parsed.messages[1]!.content) as typeof seen[number]['user']
      seen.push({ authorization: request.headers.authorization, user })
      if ('status' in answer) return void response.writeHead(answer.status, { 'content-type': 'application/json', 'retry-after-ms': '1' }).end('{"error":{"message":"down"}}')
      const content = JSON.stringify({ command_echo: user.command, ...answer, reasoning: 'It prints a number.' })
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'c', object: 'chat.completion', created: 1, model: 'GPT-6-luna', choices: [{ index: 0, message: { role: 'assistant', content, refusal: null }, finish_reason: 'stop', logprobs: null }] }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen }
}

/** A TypeSafe System One endpoint that answers the safety question as `answer` says, with the versioned model that answered. */
async function quickStandIn(answer: { choice: 'safe' | 'warning' | 'danger'; confidence: number }) {
  const seen: Array<{ authorization: string | undefined; body: { model: string; state: { command: string } } }> = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      seen.push({ authorization: request.headers.authorization, body: JSON.parse(body) as typeof seen[number]['body'] })
      const rest = (1 - answer.confidence) / 2
      const probabilities = { safe: rest, warning: rest, danger: rest, [answer.choice]: answer.confidence }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ model: 'jev-1.13.0', answers: { safety: { type: 'choice', choice: answer.choice, confidence: answer.confidence, probabilities } }, usage: { input_tokens: 100, output_tokens: 1 } }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

async function node(input: { url: string; judge?: string; quickUrl?: string; quick?: string; noThorough?: true }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-on-request-')))
  roots.push(root)
  const folder = join(root, 'site')
  mkdirSync(folder)
  writeFileSync(join(folder, 'job.py'), 'print(1)\n')
  const config = loadConfig({
    BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ADMIN_TOKEN: 'on-request-admin-credential', BUCKLE_SANDBOX: 'none',
    BUCKLE_PACKS: 'fs,shell', BUCKLE_ALLOW_SHELL: 'true', BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_APPROVAL_TIMEOUT_MS: '1',
    BUCKLE_APPROVAL_JUDGE: input.judge ?? 'on-request', BUCKLE_APPROVAL_JUDGE_PROVIDER: 'openai-compatible', BUCKLE_APPROVAL_JUDGE_MODEL: 'GPT-6-luna',
    ...(input.noThorough ? {} : { BUCKLE_JUDGE_API_KEY: KEY }), BUCKLE_JUDGE_BASE_URL: input.url,
    ...(input.quickUrl ? { BUCKLE_APPROVAL_QUICK_JUDGE: input.quick ?? 'interpreters', BUCKLE_QUICK_JUDGE_API_KEY: QUICK_KEY, BUCKLE_QUICK_JUDGE_BASE_URL: input.quickUrl } : {}),
  })
  let out = ''
  let err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { err += String(chunk); return true })
  const buckle = async (argv: string[]) => {
    out = ''
    err = ''
    const result = await runCli({ argv, config, confirm: null, cwd: folder })
    return { ...result, out, err }
  }
  expect((await buckle(['workspace', 'init'])).exitCode).toBe(0)
  const manager = await workspacesOf(config)
  // At its real path: with no bubblewrap here, the shell is withheld under a mount.
  await manager.updateSettings(idOf(manager, 'site'), settings => withMount(settings, null))
  const { runtime } = await byName(manager, 'site')
  // The folder's writes are granted, so the call's one ask is the interpreter's.
  await runtime.grants.grant({ sessionId: 'agent', rule: 'write_scope', subject: folder, scope: 'always' })
  return { buckle, runtime, manager, folder }
}

async function ask(runtime: CoreRuntime, requestId = 'on-request-1', call: { command: string; args: string[] } = { command: 'python3', args: ['job.py'] }) {
  const request = { requestId, approvalTokens: [] as string[], tool: 'shell_exec', args: call }
  const response = await runtime.invoke({ request, sessionId: 'agent', approvalWait: { mode: 'none' } })
  if (response.outcome !== 'approval_required') throw new Error(`expected an ask, got ${JSON.stringify(response)}`)
  return { request, token: response.approvals.find(approval => approval.rule === 'destructive_command')!.token }
}

describe('buckle approvals judge', () => {
  it('prints the verdict beside the whole action, and with --approve-if-safe approves a safe verdict once, the judge named', async () => {
    const judge = await standIn({ level: 'safe', confidence: 0.91 })
    const { buckle, runtime, manager } = await node({ url: judge.url })
    const { request, token } = await ask(runtime)

    const shown = await buckle(['approvals', 'judge', token])
    expect(shown.exitCode).toBe(0)
    expect(shown.out).toMatch(/ {2}judge: {4}safe \(0\.91, GPT-6-luna, \d+ ms\): It prints a number\./)
    expect(shown.out).toMatch(/does: +Run "python3 job.py"/)
    expect(shown.out).toContain(`Nothing is approved; ${token} is still waiting`)
    expect(judge.seen[0]).toMatchObject({ authorization: `Bearer ${KEY}`, user: { command: 'python3 job.py', files: [{ path: '/workspace/job.py', content: 'print(1)\n' }] } })
    expect(runtime.approvalService.waitingAsk(token)).toBeDefined()

    const approved = await buckle(['approvals', 'judge', token, '--approve-if-safe'])
    expect(approved.exitCode).toBe(0)
    expect(approved.out).toContain(`Approved ${token} once`)
    expect(runtime.approvalService.waitingAsk(token)).toBeUndefined()
    expect(claims).toEqual([{ source: SOURCES.judge, scope: 'once' }])
    // The command is audited with what the judge said, and the call it approved names the judge as who decided.
    const audited = (await auditEntries(runtime.actions, 100)).find(entry => entry.tool === 'cli_approvals' && entry.event === 'result' && entry.detail?.includes('approved once'))
    expect(audited?.judge).toMatchObject({ provider: 'openai-compatible', model: 'GPT-6-luna', level: 'safe', confidence: 0.91, passed: true })
    const decided = (await auditEntries(runtime.actions, 100)).find(entry => entry.tool === 'approval_decision' && entry.event === 'result')
    expect(decided).toMatchObject({ outcome: 'ok', args: { token, outcome: 'approve', scope: 'once', source: SOURCES.judge, decidedBy: 'judge:thorough:openai-compatible:GPT-6-luna', assurance: 'relayed' } })
    const ran = await runtime.invoke({ request: { ...request, approvalTokens: [token] }, sessionId: 'agent' })
    expect(ran.outcome).not.toBe('approval_required')
    const result = (await auditEntries(runtime.actions, 100)).find(entry => entry.event === 'result' && entry.requestId === request.requestId && entry.outcome !== 'approval_required')
    expect(result?.decidedBy).toEqual(['judge:thorough:openai-compatible:GPT-6-luna'])
    expect(shown.out + approved.out).not.toContain(KEY)
    await manager.close()
  })

  it('leaves the once unspent where the code changed after the rating, and asks again with the reason (fix brief 9, B31)', async () => {
    const judge = await standIn({ level: 'safe', confidence: 0.91 })
    const { buckle, runtime, manager, folder } = await node({ url: judge.url })
    const { request, token } = await ask(runtime)
    expect((await buckle(['approvals', 'judge', token, '--approve-if-safe'])).out).toContain(`Approved ${token} once`)
    writeFileSync(join(folder, 'job.py'), 'print("planted")\n')
    const changed = await runtime.invoke({ request: { ...request, approvalTokens: [token] }, sessionId: 'agent', approvalWait: { mode: 'none' } })
    expect(changed).toMatchObject({ outcome: 'approval_required' })
    if (changed.outcome === 'approval_required') expect(changed.approvals).toEqual([expect.objectContaining({ rule: 'destructive_command', reason: expect.stringContaining(CODE_CHANGED_REASON) })])
    expect((await auditEntries(runtime.actions, 100)).some(entry => entry.event === 'result' && entry.requestId === request.requestId && entry.outcome === 'ok')).toBe(false)
    // The once still holds for the code it was given for.
    writeFileSync(join(folder, 'job.py'), 'print(1)\n')
    const kept = await runtime.invoke({ request: { ...request, approvalTokens: [token] }, sessionId: 'agent', approvalWait: { mode: 'none' } })
    expect(kept).toMatchObject({ outcome: 'ok', output: { stdout: '1\n' } })
    await manager.close()
  })

  it('says so where the ask\'s recorded arguments hide a credential, rating nothing and leaving the ask waiting (fix brief 9, B34)', async () => {
    const judge = await standIn({ level: 'safe', confidence: 0.91 })
    const { buckle, runtime, manager } = await node({ url: judge.url })
    for (const [index, hidden] of ['https://me:decoyvalue123@example.com/x', '--token=decoyvalue123'].entries()) {
      const { token } = await ask(runtime, `hidden-${index}`, { command: 'python3', args: ['job.py', hidden] })
      for (const argv of [['approvals', 'judge', token], ['approvals', 'judge', token, '--approve-if-safe']]) {
        const result = await buckle(argv)
        expect(result.exitCode, hidden).toBe(1)
        expect(result.err + result.out, hidden).toContain(CREDENTIAL_HIDDEN)
        expect(result.err + result.out, hidden).not.toContain('decoyvalue123')
      }
      expect(runtime.approvalService.waitingAsk(token), hidden).toBeDefined()
    }
    expect(judge.seen).toHaveLength(0)
    expect(CREDENTIAL_HIDDEN).toBe('The ask\'s recorded arguments hide a credential, so the decision AI cannot rebuild the call to read it; approve or deny it yourself, or run the workspace in automated mode, which rates the call as sent')
    await manager.close()
  })

  it('says only the thorough stage can approve where it did not rate the ask, and that it gave no verdict where it failed (fix brief 9, B37)', async () => {
    const judge = await standIn({ status: 500 })
    const jev = await quickStandIn({ choice: 'safe', confidence: 0.95 })
    const quickOnly = await node({ url: judge.url, quickUrl: jev.url, noThorough: true })
    const first = await ask(quickOnly.runtime)
    const alone = await quickOnly.buckle(['approvals', 'judge', first.token, '--approve-if-safe'])
    expect(alone.exitCode).toBe(0)
    expect(alone.out).toContain(`Only the thorough stage can approve; it did not rate this ask, so nothing is approved; ${first.token} is still waiting`)
    expect(alone.out).not.toContain('Not safe')
    expect(quickOnly.runtime.approvalService.waitingAsk(first.token)).toBeDefined()
    expect((await auditEntries(quickOnly.runtime.actions, 100)).some(entry => entry.judge?.passed === true)).toBe(false)
    await quickOnly.manager.close()

    const both = await node({ url: judge.url, quickUrl: jev.url })
    const second = await ask(both.runtime)
    const failed = await both.buckle(['approvals', 'judge', second.token, '--approve-if-safe'])
    expect(failed.exitCode).toBe(0)
    expect(failed.out).toContain(`The thorough stage gave no verdict, so nothing is approved; ${second.token} is still waiting`)
    expect(both.runtime.approvalService.waitingAsk(second.token)).toBeDefined()
    await both.manager.close()
  })

  it('runs both stages the settings name, prints both verdicts, and approves on the thorough stage\'s safe verdict alone (addendum 3 R1)', async () => {
    const judge = await standIn({ level: 'danger', confidence: 0.95 })
    const jev = await quickStandIn({ choice: 'safe', confidence: 0.92 })
    const { buckle, runtime, manager } = await node({ url: judge.url, quickUrl: jev.url })
    const { token } = await ask(runtime)

    const shown = await buckle(['approvals', 'judge', token])
    expect(shown.exitCode).toBe(0)
    expect(shown.out).toMatch(/ {2}judge: {4}quick: safe \(0\.92, jev-1\.13\.0, \d+ ms\); thorough: danger \(0\.95, GPT-6-luna, \d+ ms\): It prints a number\./)
    expect(jev.seen[0]).toMatchObject({ authorization: `Bearer ${QUICK_KEY}`, body: { model: 'jev-latest', state: { command: 'python3 job.py' } } })
    expect(judge.seen).toHaveLength(1)

    // Jev's safe alone approves nothing.
    const refused = await buckle(['approvals', 'judge', token, '--approve-if-safe'])
    expect(refused.exitCode).toBe(0)
    expect(refused.out).toContain(`Not safe at 0.8 or above, so nothing is approved; ${token} is still waiting`)
    expect(runtime.approvalService.waitingAsk(token)).toBeDefined()
    expect((await auditEntries(runtime.actions, 100)).some(entry => entry.judge?.passed === true)).toBe(false)
    expect(shown.out + refused.out).not.toContain(QUICK_KEY)
    await manager.close()

    // The thorough stage's safe approves once, recorded as the thorough stage's, Jev's danger beside it.
    const safe = await standIn({ level: 'safe', confidence: 0.9 })
    const wary = await quickStandIn({ choice: 'danger', confidence: 0.9 })
    const second = await node({ url: safe.url, quickUrl: wary.url })
    const { request, token: other } = await ask(second.runtime, 'on-request-3')
    const approved = await second.buckle(['approvals', 'judge', other, '--approve-if-safe'])
    expect(approved.exitCode).toBe(0)
    expect(approved.out).toContain(`Approved ${other} once in workspace site, on the decision AI's thorough stage's safe verdict`)
    const audited = (await auditEntries(second.runtime.actions, 100)).find(entry => entry.tool === 'cli_approvals' && entry.event === 'result' && entry.detail?.includes('approved once'))
    expect(audited?.judge).toMatchObject({ level: 'safe', passed: true, passedBy: 'thorough', quick: { provider: 'typesafe', model: 'jev-1.13.0', level: 'danger' } })
    await second.runtime.invoke({ request: { ...request, approvalTokens: [other] }, sessionId: 'agent' })
    const result = (await auditEntries(second.runtime.actions, 100)).find(entry => entry.event === 'result' && entry.requestId === request.requestId && entry.outcome !== 'approval_required')
    expect(result?.decidedBy).toEqual(['judge:thorough:openai-compatible:GPT-6-luna'])
    await second.manager.close()
  })

  it('approves nothing on a verdict that is not safe at 0.8 or above, and exits 1 where there is none', async () => {
    const danger = await standIn({ level: 'danger', confidence: 0.97 })
    const first = await node({ url: danger.url })
    const { token } = await ask(first.runtime)
    const refused = await first.buckle(['approvals', 'judge', token, '--approve-if-safe'])
    expect(refused.exitCode).toBe(0)
    expect(refused.out).toMatch(/ {2}judge: {4}danger \(0\.97, GPT-6-luna, \d+ ms\): It prints a number\./)
    expect(refused.out).toContain(`Not safe at 0.8 or above, so nothing is approved; ${token} is still waiting`)
    expect(first.runtime.approvalService.waitingAsk(token)).toBeDefined()
    await first.manager.close()

    const down = await standIn({ status: 500 })
    const second = await node({ url: down.url })
    const { token: other } = await ask(second.runtime, 'on-request-2')
    const failed = await second.buckle(['approvals', 'judge', other, '--approve-if-safe'])
    expect(failed.exitCode).toBe(1)
    expect(failed.out).toContain('  judge:    no verdict: the API answered HTTP 500')
    expect(second.runtime.approvalService.waitingAsk(other)).toBeDefined()
    await second.manager.close()
  })

  it('refuses where the judge is off, and for an ask that is not an interpreter\'s, asking no one', async () => {
    const judge = await standIn({ level: 'safe', confidence: 0.99 })
    const off = await node({ url: judge.url, judge: 'off' })
    const { token } = await ask(off.runtime)
    const refused = await off.buckle(['approvals', 'judge', token])
    expect(refused.exitCode).toBe(1)
    expect(refused.err).toContain('The decision AI is off in workspace site')
    expect(judge.seen).toHaveLength(0)
    await off.manager.close()

    const on = await node({ url: judge.url })
    // A built-in floor reason asks at the same rule, and is never the judge's.
    const floor = await on.runtime.invoke({ request: { requestId: 'floor-1', approvalTokens: [], tool: 'shell_exec', args: { command: 'rm', args: ['-rf', 'build'] } }, sessionId: 'agent', approvalWait: { mode: 'none' } })
    if (floor.outcome !== 'approval_required') throw new Error(`expected an ask, got ${floor.outcome}`)
    const other = await on.buckle(['approvals', 'judge', floor.approvals.find(approval => approval.rule === 'destructive_command')!.token])
    expect(other.exitCode).toBe(1)
    expect(other.err).toContain('The decision AI rates an ask about running a command, an interpreter the policy does not allow or one the quick stage\'s scope covers')
    expect(judge.seen).toHaveLength(0)
    expect((await on.buckle(['approvals', 'show', 'x', '--approve-if-safe'])).err).toContain('--approve-if-safe is for buckle approvals judge <token>')
    await on.manager.close()
  })
  it('refuses to rate a call the policy now denies, asking neither stage, under quickJudge all (fix brief 7, B18)', async () => {
    const judge = await standIn({ level: 'safe', confidence: 0.95 })
    const jev = await quickStandIn({ choice: 'safe', confidence: 0.95 })
    const { buckle, runtime, manager } = await node({ url: judge.url, quickUrl: jev.url, quick: 'all' })
    const { token } = await ask(runtime)
    await runtime.policy.apply({ ...emptyWorkspacePolicy(), commands: { allow: [], deny: ['python3 *'], destructive: [] } })
    const refused = await buckle(['approvals', 'judge', token, '--approve-if-safe'])
    expect(refused.exitCode).toBe(1)
    expect(refused.err).toContain('The policy now denies this call; the decision AI never rates a deny')
    expect(judge.seen).toHaveLength(0)
    expect(jev.seen).toHaveLength(0)
    expect(runtime.approvalService.waitingAsk(token)).toBeDefined()
    expect((await auditEntries(runtime.actions, 200)).some(entry => entry.judge?.passed === true)).toBe(false)
    await manager.close()
  })
  it('rates a floor ask with both stages and prints both verdicts, and --approve-if-safe approves nothing for one, saying why (addendum 3 R2)', async () => {
    const judge = await standIn({ level: 'safe', confidence: 0.99 })
    const jev = await quickStandIn({ choice: 'safe', confidence: 0.95 })
    const { buckle, runtime, manager } = await node({ url: judge.url, quickUrl: jev.url, quick: 'asks' })
    await runtime.policy.apply({ ...emptyWorkspacePolicy(), commands: { allow: [], deny: [], destructive: ['make clean'] } })
    for (const [requestId, call] of [['floor-sudo', { command: 'sudo', args: ['ls'] }], ['floor-listed', { command: 'make', args: ['clean'] }]] as const) {
      const { token } = await ask(runtime, requestId, { ...call, args: [...call.args] })
      const seen = judge.seen.length
      const result = await buckle(['approvals', 'judge', token, '--approve-if-safe'])
      expect(result.exitCode, requestId).toBe(0)
      expect(judge.seen, requestId).toHaveLength(seen + 1)
      expect(result.out, requestId).toMatch(/ {2}judge: {4}a command at the destructive floor always needs a person; quick: safe \(0\.95, jev-1\.13\.0, \d+ ms\); thorough: safe \(0\.99, GPT-6-luna, \d+ ms\)/)
      expect(result.out, requestId).toContain(`A command at the destructive floor always needs a person, so nothing is approved; ${token} is still waiting`)
      expect(runtime.approvalService.waitingAsk(token), requestId).toBeDefined()
      // Without --approve-if-safe the gate's own guard alone keeps the thorough stage's safe from marking a floor ask passed (fix brief 8, B26).
      const rated = await runtime.judgeAsk(token)
      expect(rated.kind, requestId).toBe('rated')
      if (rated.kind === 'rated') expect(rated.judged, requestId).not.toHaveProperty('passedBy')
      const shown = await buckle(['approvals', 'judge', token])
      expect(shown.exitCode, requestId).toBe(0)
      expect(shown.out, requestId).toContain(`Nothing is approved; ${token} is still waiting`)
    }
    expect((await auditEntries(runtime.actions, 200)).some(entry => entry.judge?.passed === true)).toBe(false)
    // No audit entry of a floor ask carries passedBy: a pass recorded for the wrong ask (fix brief 8, B26).
    expect((await auditEntries(runtime.actions, 200)).flatMap(entry => (entry.judge && 'passedBy' in entry.judge ? [entry.judge.passedBy] : []))).toEqual([])
    await manager.close()
  })

  it('approves nothing for an ask the ledger reads as the floor, one recorded before the marks, and says so as for any floor ask', async () => {
    const judge = await standIn({ level: 'safe', confidence: 0.99 })
    const { buckle, runtime, manager } = await node({ url: judge.url })
    const { token } = await ask(runtime, 'unmarked')
    const file = approvalsPath((await byName(manager, 'site')).config)
    const ledger = JSON.parse(readFileSync(file, 'utf8')) as { pending: Array<{ request: { token: string }; floor?: boolean; destructive?: boolean }> }
    const kept = ledger.pending.find(entry => entry.request.token === token)!
    delete kept.floor
    delete kept.destructive
    writeFileSync(file, JSON.stringify(ledger))
    const result = await buckle(['approvals', 'judge', token, '--approve-if-safe'])
    expect(result.exitCode).toBe(0)
    expect(result.out).toContain(`A command at the destructive floor always needs a person, so nothing is approved; ${token} is still waiting`)
    expect(runtime.approvalService.waitingAsk(token)).toBeDefined()
    expect((await auditEntries(runtime.actions, 200)).some(entry => entry.judge?.passed === true)).toBe(false)
    await manager.close()
  })

  it('keeps the floor\'s line on a floor ask whose reading refuses, approving nothing and asking no stage (fix brief 8, B26)', async () => {
    const judge = await standIn({ level: 'safe', confidence: 0.99 })
    const jev = await quickStandIn({ choice: 'safe', confidence: 0.95 })
    const { buckle, runtime, manager } = await node({ url: judge.url, quickUrl: jev.url, quick: 'asks' })
    // sudo -D changes the working directory before the command runs, so no stage is shown it (fix brief 2, H2).
    const { token } = await ask(runtime, 'floor-unread', { command: 'sudo', args: ['-D', '/tmp', 'ls'] })
    const rated = await runtime.judgeAsk(token)
    expect(rated).toMatchObject({ kind: 'rated', judged: { cause: 'floor', thorough: { result: { kind: 'unavailable', reason: CHANGES_DIRECTORY } } } })
    for (const flags of [[], ['--approve-if-safe']]) {
      const result = await buckle(['approvals', 'judge', token, ...flags])
      expect(result.exitCode, flags.join()).toBe(1)
      expect(result.out, flags.join()).toContain(`  judge:    ${FLOOR_WARNING}; no verdict: ${CHANGES_DIRECTORY}`)
      expect(result.out, flags.join()).toContain(`The decision AI gave no verdict, so nothing is approved; ${token} is still waiting`)
    }
    expect(judge.seen).toHaveLength(0)
    expect(jev.seen).toHaveLength(0)
    expect(runtime.approvalService.waitingAsk(token)).toBeDefined()
    expect((await auditEntries(runtime.actions, 200)).flatMap(entry => (entry.judge && 'passedBy' in entry.judge ? [entry.judge.passedBy] : []))).toEqual([])
    await manager.close()
  })
})

// D91 follow-up F6: a waiting ask the judge has not rated yet says how to ask it, and that --approve-if-safe approves a
// safe verdict once only where the thorough stage holds a key; every route that shows the line reads the same flag.
describe('the line a waiting ask carries before it is rated, on every CLI route that shows it (follow-up F6)', () => {
  const clause = ', and with --approve-if-safe approves a safe verdict once'
  const routes = (token: string) => [['approvals'], ['approvals', 'show', token], ['approve', token]]

  it('offers --approve-if-safe where the thorough stage holds a key, on the listing, on show, and on approve', async () => {
    const judge = await standIn({ level: 'safe', confidence: 0.91 })
    const { buckle, runtime, manager } = await node({ url: judge.url })
    const { token } = await ask(runtime)
    expect(runtime.judgeApproves()).toBe(true)
    for (const argv of routes(token)) {
      const shown = await buckle(argv)
      expect(shown.out, argv.join(' ')).toContain(`judge:    not asked; buckle approvals judge ${token} --workspace site asks it${clause}\n`)
    }
    await manager.close()
  })

  it('offers no approval where only Jev holds a key, on the listing, on show, and on approve, and still shows the whole action', async () => {
    const judge = await standIn({ status: 500 })
    const jev = await quickStandIn({ choice: 'safe', confidence: 0.95 })
    const { buckle, runtime, manager } = await node({ url: judge.url, quickUrl: jev.url, noThorough: true })
    const { token } = await ask(runtime)
    expect(runtime.judgeApproves()).toBe(false)
    for (const argv of routes(token)) {
      const shown = await buckle(argv)
      expect(shown.out, argv.join(' ')).toContain(`judge:    not asked; buckle approvals judge ${token} --workspace site asks it\n`)
      expect(shown.out, argv.join(' ')).not.toContain('--approve-if-safe')
      expect(shown.out, argv.join(' ')).toMatch(/does: +Run "python3 job\.py"/)
      expect(shown.out, argv.join(' ')).toContain('"command": "python3"')
    }
    expect(judge.seen).toHaveLength(0)
    expect(jev.seen).toHaveLength(0)
    await manager.close()
  })
})
