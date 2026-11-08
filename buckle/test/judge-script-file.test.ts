import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyWorkspacePolicy } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BuckleConfig } from '../common/runtime/config.js'
import { CODE_REFUSALS } from '../common/services/judge/code-reader.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import type { Judge, JudgeInput, JudgeResult } from '../common/types/ports/judge.js'
import type { QuickJudge, QuickResult } from '../common/types/ports/quick-judge.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { auditEntries, settleAuditLogs } from './support/action-log-writer.js'

// The decision AI on a script file run directly: it may answer the ask as it answers an unknown
// interpreter's, shown the script's code where the reader can place it (a script sh, bash, or dash runs as the call
// itself), and a person decides any other script run.

const roots: string[] = []
const runtimes: CoreRuntime[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  await settleAuditLogs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const DEPLOY = 'echo deploying\n. ./lib/common.sh\n'

function node(): BuckleConfig {
  const root = mkdtempSync(join(tmpdir(), 'buckle-judge-script-'))
  const state = mkdtempSync(join(tmpdir(), 'buckle-judge-script-state-'))
  roots.push(root, state)
  mkdirSync(join(root, 'lib'))
  writeFileSync(join(root, 'deploy.sh'), DEPLOY)
  writeFileSync(join(root, 'lib', 'common.sh'), 'export STAGE=prod\n')
  return configFromEnvironment({
    BUCKLE_WORKSPACE_ROOT: root, BUCKLE_STATE_DIR: state,
    BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'true', BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_PACKS: 'fs,shell', BUCKLE_APPROVAL_TIMEOUT_MS: '1',
    BUCKLE_APPROVAL_JUDGE: 'automated', BUCKLE_APPROVAL_QUICK_JUDGE: 'off',
  })
}

const SAFE: JudgeResult = { kind: 'verdict', level: 'safe', confidence: 0.95, reasoning: 'Rated safe.', model: 'gpt-6-luna', latencyMs: 900, promptDigest: 'd'.repeat(64) }
const NO_QUICK: QuickResult = { kind: 'unavailable', reason: 'not asked' }

async function runtimeOf(config: BuckleConfig) {
  const shown: JudgeInput[] = []
  const judge: Judge = { judge: vi.fn(async (input: JudgeInput) => { shown.push(input); return SAFE }) }
  const quickJudge: QuickJudge = { quick: vi.fn(async () => NO_QUICK) }
  const runtime = await createRuntime({ config, judge, quickJudge })
  runtimes.push(runtime)
  return { runtime, judge, shown }
}

async function call(runtime: CoreRuntime, command: string, args: string[]) {
  const execute = vi.fn(async () => 'executed')
  const prepare = vi.spyOn(runtime.registry().get('shell_exec'), 'prepare').mockReturnValue({ effects: [{ kind: 'exec', command, args }], execute })
  const requestId = `script-${Math.random()}`
  try {
    const response = await runtime.invoke({ request: { requestId, approvalTokens: [], tool: 'shell_exec', args: {} }, sessionId: 'script', approvalWait: { mode: 'none' } })
    const entry = (await auditEntries(runtime.actions, 200)).find(item => item.event === 'result' && item.requestId === requestId)!
    return { response, entry, ran: execute.mock.calls.length > 0 }
  } finally { prepare.mockRestore() }
}

describe('the decision AI on a script a shell runs', () => {
  it.each([
    ['bash', ['deploy.sh']],
    ['sh', ['deploy.sh', '--prod']],
    ['dash', ['-e', 'deploy.sh']],
    ['bash', ['-eu', '-o', 'pipefail', './deploy.sh']],
  ])('%s %j: the thorough stage is shown the script and what it sources, and its safe runs the call', async (command, args) => {
    const { runtime, judge, shown } = await runtimeOf(node())
    const { response, entry, ran } = await call(runtime, command, args)
    expect(judge.judge).toHaveBeenCalledTimes(1)
    expect(shown[0]!.files.map(file => [file.path.split('/').slice(-2).join('/'), file.content])).toEqual([[expect.stringMatching(/deploy\.sh$/), DEPLOY], ['lib/common.sh', 'export STAGE=prod\n']])
    expect(response).toMatchObject({ outcome: 'ok' })
    expect(ran).toBe(true)
    expect(entry.judge).toMatchObject({ level: 'safe', passed: true, passedBy: 'thorough' })
  })

  it.each([
    ['a script that is not there, which bash would look for on PATH', 'bash', ['missing.sh'], CODE_REFUSALS.notFound],
    ['a login shell, which runs profile files first', 'bash', ['-l', 'deploy.sh'], CODE_REFUSALS.startupFiles],
    ['an interactive shell, which runs its rc file first', 'bash', ['-i', 'deploy.sh'], CODE_REFUSALS.startupFiles],
    ['an option the reader does not model', 'bash', ['--debugger', 'deploy.sh'], CODE_REFUSALS.startupFiles],
    ['an unmodelled shell option', 'bash', ['-k', 'deploy.sh'], CODE_REFUSALS.unknownOption],
    ['a shell whose startup files the reader does not follow', 'zsh', ['deploy.sh'], CODE_REFUSALS.scriptFile],
  ])('%s: %s %j goes to a person, the stages shown nothing', async (_, command, args, reason) => {
    const { runtime, judge } = await runtimeOf(node())
    const { response, entry, ran } = await call(runtime, command, args)
    expect(judge.judge).not.toHaveBeenCalled()
    expect(response).toMatchObject({ outcome: 'approval_required' })
    expect(ran).toBe(false)
    expect(entry.judge).toMatchObject({ unavailable: reason, passed: false })
  })
})

describe('the decision AI on any other script run', () => {
  const SHELL_BODIES = ['bash -c *']
  it.each([
    ['a script by its path in the workspace', './deploy.sh', [], [], CODE_REFUSALS.localInterpreter],
    ['a script a shell body runs by its path', 'bash', ['-c', './deploy.sh'], SHELL_BODIES, CODE_REFUSALS.scriptFile],
    ['a script a shell body sources', 'bash', ['-c', 'source ./deploy.sh'], SHELL_BODIES, CODE_REFUSALS.scriptFile],
    ['a script a shell body hands bash', 'bash', ['-c', 'bash deploy.sh'], SHELL_BODIES, CODE_REFUSALS.scriptFile],
  ])('%s: %s %j goes to a person, the stages shown nothing', async (_, command, args, allow, reason) => {
    const { runtime, judge } = await runtimeOf(node())
    const policy = emptyWorkspacePolicy()
    await runtime.policy.apply({ ...policy, commands: { ...policy.commands, allow } })
    const { response, entry, ran } = await call(runtime, command, args)
    expect(judge.judge).not.toHaveBeenCalled()
    expect(response).toMatchObject({ outcome: 'approval_required' })
    expect(ran).toBe(false)
    expect(entry.judge).toMatchObject({ unavailable: reason, passed: false })
  })

  it('sends a person a program named by an absolute path outside the workspace and the system folders, which the agent\'s shell may have written there', async () => {
    const config = node()
    const elsewhere = mkdtempSync(join(tmpdir(), 'buckle-judge-script-elsewhere-'))
    roots.push(elsewhere)
    writeFileSync(join(elsewhere, 'run'), '#!/bin/sh\nrm -rf "$HOME"\n', { mode: 0o700 })
    const { runtime, judge } = await runtimeOf(config)
    const { response, entry, ran } = await call(runtime, join(elsewhere, 'run'), [])
    expect(judge.judge).not.toHaveBeenCalled()
    expect(response).toMatchObject({ outcome: 'approval_required' })
    expect(ran).toBe(false)
    expect(entry.judge).toMatchObject({ unavailable: CODE_REFUSALS.scriptFile, passed: false })
  })

  it('runs a system program named by its path with no ask, so no stage rates it', async () => {
    const { runtime, judge } = await runtimeOf(node())
    const { response, ran } = await call(runtime, '/usr/bin/env', ['true'])
    expect(judge.judge).not.toHaveBeenCalled()
    expect(response).toMatchObject({ outcome: 'ok' })
    expect(ran).toBe(true)
  })
})
