import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyWorkspacePolicy, type WorkspacePolicy } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTypeSafeQuickJudge } from '../common/adapters/judge/typesafe.js'
import { QUICK_FLAG_REASON } from '../common/domain/permission/judged.js'
import type { BuckleConfig } from '../common/runtime/config.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import type { Judge, JudgeInput, JudgeLevel } from '../common/types/ports/judge.js'
import type { QuickJudge, QuickResult } from '../common/types/ports/quick-judge.js'
import { configFromEnvironment } from './support/workspace-config.js'

// approval.quickJudge all (D91, addendum 2 B): every command is rated by the quick stage, allowed ones included. An
// allowed command runs unless Jev rates it danger at 0.8 or above, which turns the run into an ask with the verdict beside
// the whole action; an unavailable quick result lets it run as before, nothing the AI says refuses a command, and a deny
// is never rated. In on-request mode, all changes nothing for allowed commands.

const roots: string[] = []
const runtimes: BuckleRuntime[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function node(environment: NodeJS.ProcessEnv = {}): BuckleConfig {
  const root = mkdtempSync(join(tmpdir(), 'buckle-judge-screen-'))
  const state = mkdtempSync(join(tmpdir(), 'buckle-judge-screen-state-'))
  roots.push(root, state)
  writeFileSync(join(root, 'notes.txt'), 'hello\n')
  return configFromEnvironment({
    BUCKLE_WORKSPACE_ROOT: root, BUCKLE_STATE_DIR: state,
    BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'true', BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_PACKS: 'fs,shell', BUCKLE_APPROVAL_TIMEOUT_MS: '60000',
    BUCKLE_APPROVAL_JUDGE: 'automated', BUCKLE_APPROVAL_QUICK_JUDGE: 'all',
    ...environment,
  })
}

function quick(level: JudgeLevel, confidence: number): QuickResult {
  const rest = (1 - confidence) / 2
  return { kind: 'verdict', level, confidence, probabilities: { safe: rest, warning: rest, danger: rest, [level]: confidence } as Record<JudgeLevel, number>, model: 'jev-1.13.0', latencyMs: 90 }
}

function fakes(answer: QuickResult) {
  const quickJudge: QuickJudge = { quick: vi.fn(async () => answer) }
  const judge: Judge = { judge: vi.fn(async () => ({ kind: 'unavailable' as const, reason: 'not asked in these tests' })) }
  return { quickJudge, judge }
}

async function runtimeOf(config: BuckleConfig, judges: { judge: Judge; quickJudge: QuickJudge }): Promise<BuckleRuntime> {
  const runtime = await createRuntime({ config, ...judges })
  runtimes.push(runtime)
  return runtime
}

async function call(runtime: BuckleRuntime, command: string, args: string[], approvalTokens: string[] = [], requestId = `screen-${Math.random()}`) {
  const execute = vi.fn(async () => 'executed')
  const prepare = vi.spyOn(runtime.registry().get('shell_exec'), 'prepare').mockReturnValue({ effects: [{ kind: 'exec', command, args }], execute })
  try {
    const response = await runtime.invoke({ request: { requestId, approvalTokens, tool: 'shell_exec', args: {} }, sessionId: 'screen', approvalWait: { mode: 'none' } })
    const entry = runtime.actions.read(400).filter(item => item.event === 'result' && item.requestId === requestId).at(-1)!
    return { response, entry, ran: execute.mock.calls.length > 0 }
  } finally { prepare.mockRestore() }
}

async function withPolicy(runtime: BuckleRuntime, commands: Partial<WorkspacePolicy['commands']>) {
  await runtime.policy.apply({ ...emptyWorkspacePolicy(), commands: { allow: [], deny: [], ...commands } })
}

describe('an allowed command, with the quick stage on for all', () => {
  it('asks where Jev rates it danger at 0.8 or above, the verdict beside the action and the level alone in the agent\'s reason', async () => {
    const judges = fakes(quick('danger', 0.91))
    const runtime = await runtimeOf(node(), judges)
    const { response, entry, ran } = await call(runtime, 'cat', ['notes.txt'])
    expect(ran).toBe(false)
    expect(response).toMatchObject({ outcome: 'approval_required', approvals: [{ rule: 'destructive_command', subject: expect.stringMatching(/^cat notes\.txt /), reason: QUICK_FLAG_REASON }] })
    expect(entry.judge).toEqual({ quick: { provider: 'typesafe', model: 'jev-1.13.0', level: 'danger', confidence: 0.91, probabilities: expect.any(Object), latencyMs: 90 }, passed: false, flagged: true, screened: true })
    expect(runtime.approvalService.listing()[0]!.call?.judge).toEqual([{ subject: expect.stringMatching(/^cat notes\.txt /), quick: { level: 'danger', confidence: 0.91, model: 'jev-1.13.0', latencyMs: 90 } }])
    expect(judges.judge.judge).not.toHaveBeenCalled()
  })

  it.each([
    ['a safe', quick('safe', 0.99)],
    ['a warning', quick('warning', 0.95)],
    ['a danger below 0.8', quick('danger', 0.7)],
    ['no verdict', { kind: 'unavailable', reason: 'the request timed out' } as QuickResult],
  ])('runs as before after %s, the rating in its audit entry', async (_, answer) => {
    const runtime = await runtimeOf(node(), fakes(answer))
    const { response, entry, ran } = await call(runtime, 'cat', ['notes.txt'])
    expect(response).toMatchObject({ outcome: 'ok' })
    expect(ran).toBe(true)
    expect(entry.judge).toMatchObject({ passed: false, screened: true })
    expect(entry.judge).not.toHaveProperty('flagged')
  })

  it('runs as before when Jev\'s 200 answer is an HTML page, through the real quick adapter', async () => {
    const fetch = vi.fn(async () => new Response('<!doctype html><html><body>Bad gateway</body></html>', { headers: { 'content-type': 'text/html' } }))
    const quickJudge = createTypeSafeQuickJudge({ apiKey: 'ts_quick-judge-fixture-0123456789', fetch: fetch as unknown as typeof globalThis.fetch })
    const runtime = await runtimeOf(node(), { quickJudge, judge: fakes(quick('safe', 0.99)).judge })
    const { response, entry, ran } = await call(runtime, 'cat', ['notes.txt'])
    expect(response).toMatchObject({ outcome: 'ok' })
    expect(ran).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(entry.judge).toMatchObject({ quick: { unavailable: 'the answer held no verdict' }, passed: false, screened: true })
  })

  it('rates npm run dev, which never asks on its own, as a standard script on its command line alone', async () => {
    const shown: JudgeInput[] = []
    const quickJudge: QuickJudge = { quick: vi.fn(async (input: JudgeInput) => { shown.push(input); return quick('safe', 0.99) }) }
    const runtime = await runtimeOf(node(), { quickJudge, judge: fakes(quick('safe', 0.99)).judge })
    expect((await call(runtime, 'npm', ['run', 'dev'])).response).toMatchObject({ outcome: 'ok' })
    expect(shown[0]).toMatchObject({ command: 'npm run dev', standardScript: true, files: [], interpreters: [] })
  })

  it('runs once a person approves the ask Jev raised, sent again with the approval\'s token', async () => {
    const judges = fakes(quick('danger', 0.95))
    const runtime = await runtimeOf(node(), judges)
    const first = await call(runtime, 'cat', ['notes.txt'], [], 'screen-approved')
    if (first.response.outcome !== 'approval_required') throw new Error('expected an ask')
    const token = first.response.approvals[0]!.token
    expect((await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'once' }, authority: 'admin' })).ok).toBe(true)
    const again = await call(runtime, 'cat', ['notes.txt'], [token], 'screen-approved')
    expect(again.response).toMatchObject({ outcome: 'ok' })
    expect(again.ran).toBe(true)
    // The second check found the verdict in the cache.
    expect(judges.quickJudge.quick).toHaveBeenCalledTimes(1)
  })

  it('is never rated past a deny, nor where the dangerously-allow switch let it through, nor in on-request mode', async () => {
    const denied = fakes(quick('safe', 0.99))
    const runtime = await runtimeOf(node(), denied)
    await withPolicy(runtime, { deny: ['cat *'] })
    expect((await call(runtime, 'cat', ['notes.txt'])).response).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED' } })
    expect(denied.quickJudge.quick).not.toHaveBeenCalled()

    const requested = fakes(quick('danger', 0.99))
    expect((await call(await runtimeOf(node({ BUCKLE_APPROVAL_JUDGE: 'on-request' }), requested), 'cat', ['notes.txt'])).response).toMatchObject({ outcome: 'ok' })
    expect(requested.quickJudge.quick).not.toHaveBeenCalled()

    const switched = fakes(quick('danger', 0.99))
    const open = await runtimeOf(node(), switched)
    await open.policy.setDangerouslyAllow(true)
    expect((await call(open, 'cat', ['notes.txt'])).response).toMatchObject({ outcome: 'ok' })
    expect(switched.quickJudge.quick).not.toHaveBeenCalled()
  })
})
