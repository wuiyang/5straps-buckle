import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../common/runtime/config.js'
import { withMount } from '../common/services/workspaces/workspace-settings.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { runCli } from './support/cli.js'
import { byName, idOf, workspacesOf } from './support/workspaces.js'

// `buckle approvals judge <token> [--approve-if-safe]` (D91, addendum C): the decision AI rates one waiting interpreter
// ask at the owner's request, through the real OpenAI-compatible adapter against a local stand-in at the node's
// BUCKLE_JUDGE_BASE_URL, and the verdict is printed beside the whole action; a safe verdict at 0.8 or above approves the
// ask once where the owner asked for that, with the judge named as who decided.

const KEY = 'sk-on-request-fixture-0123456789'
const QUICK_KEY = 'ts-on-request-fixture-0123456789'
const roots: string[] = []
const servers: Server[] = []
afterEach(async () => {
  vi.restoreAllMocks()
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

async function node(input: { url: string; judge?: string; quickUrl?: string }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-on-request-')))
  roots.push(root)
  const folder = join(root, 'site')
  mkdirSync(folder)
  writeFileSync(join(folder, 'job.py'), 'print(1)\n')
  const config = loadConfig({
    BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ADMIN_TOKEN: 'on-request-admin-credential', BUCKLE_SANDBOX: 'none',
    BUCKLE_PACKS: 'fs,shell', BUCKLE_ALLOW_SHELL: 'true', BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_APPROVAL_TIMEOUT_MS: '1',
    BUCKLE_APPROVAL_JUDGE: input.judge ?? 'on-request', BUCKLE_APPROVAL_JUDGE_PROVIDER: 'openai-compatible', BUCKLE_APPROVAL_JUDGE_MODEL: 'GPT-6-luna',
    BUCKLE_JUDGE_API_KEY: KEY, BUCKLE_JUDGE_BASE_URL: input.url,
    ...(input.quickUrl ? { BUCKLE_APPROVAL_QUICK_JUDGE: 'interpreters', BUCKLE_QUICK_JUDGE_API_KEY: QUICK_KEY, BUCKLE_QUICK_JUDGE_BASE_URL: input.quickUrl } : {}),
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
  return { buckle, runtime, manager }
}

async function ask(runtime: BuckleRuntime, requestId = 'on-request-1') {
  const request = { requestId, approvalTokens: [] as string[], tool: 'shell_exec', args: { command: 'python3', args: ['job.py'] } }
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
    // The command is audited with what the judge said, and the call it approved names the judge as who decided.
    const audited = runtime.actions.read(100).find(entry => entry.tool === 'cli_approvals' && entry.event === 'result' && entry.detail?.includes('approved once'))
    expect(audited?.judge).toMatchObject({ provider: 'openai-compatible', model: 'GPT-6-luna', level: 'safe', confidence: 0.91, passed: true })
    const ran = await runtime.invoke({ request: { ...request, approvalTokens: [token] }, sessionId: 'agent' })
    expect(ran.outcome).not.toBe('approval_required')
    const result = runtime.actions.read(100).find(entry => entry.event === 'result' && entry.requestId === request.requestId && entry.outcome !== 'approval_required')
    expect(result?.decidedBy).toEqual(['judge:thorough:openai-compatible:GPT-6-luna'])
    expect(shown.out + approved.out).not.toContain(KEY)
    await manager.close()
  })

  it('runs both stages the settings name, prints both verdicts, and approves on either stage\'s safe verdict, naming the stage', async () => {
    const judge = await standIn({ level: 'danger', confidence: 0.95 })
    const jev = await quickStandIn({ choice: 'safe', confidence: 0.92 })
    const { buckle, runtime, manager } = await node({ url: judge.url, quickUrl: jev.url })
    const { request, token } = await ask(runtime)

    const shown = await buckle(['approvals', 'judge', token])
    expect(shown.exitCode).toBe(0)
    expect(shown.out).toMatch(/ {2}judge: {4}quick: safe \(0\.92, jev-1\.13\.0, \d+ ms\); thorough: danger \(0\.95, GPT-6-luna, \d+ ms\): It prints a number\./)
    expect(jev.seen[0]).toMatchObject({ authorization: `Bearer ${QUICK_KEY}`, body: { model: 'jev-latest', state: { command: 'python3 job.py' } } })
    expect(judge.seen).toHaveLength(1)

    const approved = await buckle(['approvals', 'judge', token, '--approve-if-safe'])
    expect(approved.exitCode).toBe(0)
    expect(approved.out).toContain(`Approved ${token} once in workspace site, on the decision AI's quick stage's safe verdict`)
    const audited = runtime.actions.read(100).find(entry => entry.tool === 'cli_approvals' && entry.event === 'result' && entry.detail?.includes('approved once'))
    expect(audited?.judge).toMatchObject({ level: 'danger', passed: true, passedBy: 'quick', quick: { provider: 'typesafe', model: 'jev-1.13.0', level: 'safe' } })
    await runtime.invoke({ request: { ...request, approvalTokens: [token] }, sessionId: 'agent' })
    const result = runtime.actions.read(100).find(entry => entry.event === 'result' && entry.requestId === request.requestId && entry.outcome !== 'approval_required')
    expect(result?.decidedBy).toEqual(['judge:quick:typesafe:jev-1.13.0'])
    expect(shown.out + approved.out).not.toContain(QUICK_KEY)
    await manager.close()
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
})
