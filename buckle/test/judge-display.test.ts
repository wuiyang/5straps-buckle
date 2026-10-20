import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyWorkspacePolicy } from '@5straps/protocol'
import type { CliRequest } from '@5straps/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeQuestion } from '../cli/terminal-consumer.js'
import { describeAsk, FLOOR_WARNING } from '../common/domain/approval-instruction.js'
import type { BuckleConfig } from '../common/runtime/config.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import type { Judge, JudgeLevel, JudgeResult } from '../common/types/ports/judge.js'
import type { QuickJudge, QuickResult } from '../common/types/ports/quick-judge.js'
import { fixedInteraction } from './support/interaction.js'
import { captureWebhook } from './support/webhook.js'
import { configFromEnvironment } from './support/workspace-config.js'

// Where the decision AI ran and did not pass a call, the ask goes out with its verdict beside the whole action (D91,
// brief item 4): the terminal question's judge line, the webhook's judge object, the listing's call, and the level
// alone in the reason the agent reads. In on-request mode the approver is told the judge is available, and how to ask it.

const roots: string[] = []
const closing: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of closing.splice(0)) await close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function node(environment: NodeJS.ProcessEnv = {}): BuckleConfig {
  const root = mkdtempSync(join(tmpdir(), 'buckle-judge-shown-'))
  const state = mkdtempSync(join(tmpdir(), 'buckle-judge-shown-state-'))
  roots.push(root, state)
  writeFileSync(join(root, 'job.py'), 'print(1)\n')
  return configFromEnvironment({
    BUCKLE_WORKSPACE_ROOT: root, BUCKLE_STATE_DIR: state,
    BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'true', BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_PACKS: 'fs,shell', BUCKLE_APPROVAL_TIMEOUT_MS: '60000',
    BUCKLE_APPROVAL_JUDGE: 'automated', BUCKLE_APPROVAL_JUDGE_PROVIDER: 'openai-compatible', BUCKLE_APPROVAL_JUDGE_MODEL: 'claude-opus-5-5',
    ...environment,
  })
}

const verdict = (level: 'safe' | 'warning' | 'danger', confidence: number): JudgeResult => ({ kind: 'verdict', level, confidence, reasoning: `It deletes files. ${level}.`, model: 'claude-opus-5-5', latencyMs: 30, promptDigest: 'e'.repeat(64) })

/** A runtime whose terminal questions and webhook posts are kept; one call asks about python3 job.py. */
async function asked(input: { answer?: JudgeResult; environment?: NodeJS.ProcessEnv; quickJudge?: QuickJudge; command?: [string, string[]]; destructive?: string[] }) {
  const webhook = await captureWebhook()
  closing.push(() => webhook.close())
  const questions: CliRequest[] = []
  const requestCli = vi.fn(async (request: CliRequest) => { questions.push(request); return { status: 'unavailable' as const, requestId: request.id, reason: 'no_consumer' as const } })
  const judge: Judge = { judge: vi.fn(async () => input.answer ?? verdict('danger', 0.92)) }
  const config = node({ BUCKLE_APPROVAL_WEBHOOK: webhook.url, ...input.environment })
  const runtime: BuckleRuntime = await createRuntime({ config, judge, ...(input.quickJudge ? { quickJudge: input.quickJudge } : {}), interaction: fixedInteraction({ hold: 'grace', requestCli }) })
  closing.push(async () => { await runtime.approvalService.close(); await runtime.history.close() })
  if (input.destructive) await runtime.policy.apply({ ...emptyWorkspacePolicy(), commands: { allow: [], deny: [], destructive: input.destructive } })
  const [command, args] = input.command ?? ['python3', ['job.py']]
  vi.spyOn(runtime.registry().get('shell_exec'), 'prepare').mockReturnValue({ effects: [{ kind: 'exec', command, args }], execute: vi.fn(async () => 'executed') })
  const response = await runtime.invoke({ request: { requestId: `shown-${Math.random()}`, approvalTokens: [], tool: 'shell_exec', args: {} }, sessionId: 'shown', approvalWait: { mode: 'none' } })
  if (response.outcome !== 'approval_required') throw new Error(`expected an ask, got ${response.outcome}`)
  await vi.waitFor(() => expect(questions.length).toBeGreaterThan(0))
  await vi.waitFor(() => expect(webhook.bodies.length).toBeGreaterThan(0))
  const approval = response.approvals[0]!
  return { runtime, judge, approval, question: questions[0]!, posted: webhook.bodies[0] as { approvals: Array<Record<string, unknown>> } }
}

describe('an ask the decision AI rated and did not pass', () => {
  it.each([
    ['a danger', verdict('danger', 0.92), 'danger (0.92, claude-opus-5-5, 30 ms): It deletes files. danger.', { level: 'danger', confidence: 0.92, model: 'claude-opus-5-5', reasoning: 'It deletes files. danger.', latencyMs: 30 }, 'the decision AI rated it danger'],
    ['a warning', verdict('warning', 0.85), 'warning (0.85, claude-opus-5-5, 30 ms): It deletes files. warning.', { level: 'warning', confidence: 0.85, model: 'claude-opus-5-5', reasoning: 'It deletes files. warning.', latencyMs: 30 }, 'the decision AI rated it warning'],
    ['no verdict', { kind: 'unavailable', reason: 'the request timed out' } as JudgeResult, 'no verdict: the request timed out', { unavailable: 'the request timed out' }, 'the decision AI gave no verdict'],
  ])('shows %s beside the whole action at the terminal, in the webhook, and in the listing, and the agent the level alone', async (_, answer, line, posted, said) => {
    const { runtime, approval, question, posted: body } = await asked({ answer })
    expect(question.action.details?.judge).toBe(line)
    expect(body.approvals[0]!.judge).toEqual(posted)
    expect(approval.reason.endsWith(`; ${said}`)).toBe(true)
    expect(approval.reason).not.toContain('It deletes files')
    expect(runtime.approvalService.listing()[0]!.call?.judge).toEqual([{ subject: approval.subject, ...posted }])
    // The line every approver route reads: the serve terminal's question, and an ask read with its kept call.
    const waiting = runtime.approvalService.waitingAsk(approval.token)!
    expect(describeAsk({ ...waiting.request, workspaceName: runtime.workspaceName(), call: waiting.call! })).toContain(`  judge:    ${line}`)
  })
})

describe('the quick stage\'s verdict beside the action', () => {
  const quick = (level: JudgeLevel, confidence: number): QuickJudge => ({ quick: vi.fn(async (): Promise<QuickResult> => ({ kind: 'verdict', level, confidence, probabilities: { safe: 0, warning: 0, danger: 0, [level]: confidence } as Record<JudgeLevel, number>, model: 'jev-1.13.0', latencyMs: 120 })) })

  it('rides in the webhook\'s judge object as quick, beside the thorough verdict that followed it', async () => {
    const { runtime, approval, question, posted: body } = await asked({ answer: verdict('danger', 0.97), quickJudge: quick('warning', 0.9), environment: { BUCKLE_APPROVAL_QUICK_JUDGE: 'interpreters' } })
    const judged = { level: 'danger', confidence: 0.97, model: 'claude-opus-5-5', reasoning: 'It deletes files. danger.', latencyMs: 30, quick: { level: 'warning', confidence: 0.9, model: 'jev-1.13.0', latencyMs: 120 } }
    expect(body.approvals[0]!.judge).toEqual(judged)
    expect(runtime.approvalService.listing()[0]!.call?.judge).toEqual([{ subject: approval.subject, ...judged }])
    expect(question.action.details?.judge).toBe('quick: warning (0.90, jev-1.13.0, 120 ms); thorough: danger (0.97, claude-opus-5-5, 30 ms): It deletes files. danger.')
  })

  it('rides alone where Jev\'s danger sent the ask to a person with no thorough call', async () => {
    const { runtime, judge, approval, question, posted: body } = await asked({ quickJudge: quick('danger', 0.95), environment: { BUCKLE_APPROVAL_QUICK_JUDGE: 'interpreters' } })
    expect(judge.judge).not.toHaveBeenCalled()
    expect(body.approvals[0]!.judge).toEqual({ quick: { level: 'danger', confidence: 0.95, model: 'jev-1.13.0', latencyMs: 120 } })
    expect(runtime.approvalService.listing()[0]!.call?.judge).toEqual([{ subject: approval.subject, quick: { level: 'danger', confidence: 0.95, model: 'jev-1.13.0', latencyMs: 120 } }])
    expect(question.action.details?.judge).toBe('quick: danger (0.95, jev-1.13.0, 120 ms)')
  })
})

describe('a floor ask the quick stage rated (addendum 3 R2)', () => {
  const jev = (): QuickJudge => ({ quick: vi.fn(async (): Promise<QuickResult> => ({ kind: 'verdict', level: 'safe', confidence: 0.95, probabilities: { safe: 0.95, warning: 0.03, danger: 0.02 }, model: 'jev-1.13.0', latencyMs: 120 })) })

  it.each([
    ['sudo ls', { command: ['sudo', ['ls']] as [string, string[]] }],
    ['a workspace destructive entry', { command: ['make', ['clean']] as [string, string[]], destructive: ['make clean'] }],
  ])('is never passed on Jev\'s safe 0.95, the thorough stage not asked, and every approver route carries the floor\'s warning line: %s', async (_, call) => {
    const quickJudge = jev()
    const { runtime, judge, approval, question, posted: body } = await asked({ quickJudge, environment: { BUCKLE_APPROVAL_QUICK_JUDGE: 'asks' }, answer: verdict('safe', 0.99), ...call })
    expect(quickJudge.quick).toHaveBeenCalledTimes(1)
    expect(judge.judge).toHaveBeenCalledTimes(0)
    const quick = { level: 'safe', confidence: 0.95, model: 'jev-1.13.0', latencyMs: 120 }
    expect(question.action.details?.judge).toBe(`${FLOOR_WARNING}; quick: safe (0.95, jev-1.13.0, 120 ms)`)
    expect(body.approvals[0]!.judge).toEqual({ quick, warning: FLOOR_WARNING })
    expect(runtime.approvalService.listing()[0]!.call?.judge).toEqual([{ subject: approval.subject, quick, warning: FLOOR_WARNING }])
    expect(runtime.approvalService.waitingAsk(approval.token)).toBeDefined()
  })

  it('carries the warning line on request too, and never promises that --approve-if-safe approves it', async () => {
    const { runtime, approval, question, posted: body } = await asked({ quickJudge: jev(), environment: { BUCKLE_APPROVAL_JUDGE: 'on-request', BUCKLE_APPROVAL_QUICK_JUDGE: 'asks' }, command: ['sudo', ['ls']] })
    const command = `buckle approvals judge ${approval.token} --workspace ${runtime.workspaceName()}`
    expect(question.action.details?.judge).toBe(`${FLOOR_WARNING}; not asked; ${command} rates it`)
    expect(body.approvals[0]!.judge).toEqual({ onRequest: true, command, warning: FLOOR_WARNING })
  })
})

describe('an ask in a workspace whose judge rates on request', () => {
  it('tells the approver the judge is available and how to ask it, and the agent nothing more', async () => {
    const { runtime, judge, approval, question, posted: body } = await asked({ environment: { BUCKLE_APPROVAL_JUDGE: 'on-request' } })
    expect(judge.judge).not.toHaveBeenCalled()
    const command = `buckle approvals judge ${approval.token} --workspace ${runtime.workspaceName()}`
    expect(question.action.details?.judge).toBe(`not asked; ${command} asks it, and with --approve-if-safe approves a safe verdict once`)
    expect(body.approvals[0]!.judge).toEqual({ onRequest: true, command })
    expect(approval.reason).not.toContain('decision AI')
  })
})

describe('the judge line on a terminal', () => {
  it('escapes what the model wrote, as every rendering of agent-reachable text is', () => {
    const shown = describeQuestion({ tool: 'shell_exec', rule: 'destructive_command', subject: 'python3 job.py', reason: 'unknown interpreter', offeredScopes: ['once', 'session'], expiresAt: new Date(Date.now() + 60_000).toISOString(), judge: 'danger (0.90, m): clears\u001b[2J the screen', call: { arguments: {}, cwd: '/workspace', description: null } })
    expect(shown).toContain('  judge:    danger (0.90, m): clears\\u001b[2J the screen')
  })
})
