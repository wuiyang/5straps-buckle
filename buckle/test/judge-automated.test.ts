import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyWorkspacePolicy, type WorkspacePolicy } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeAsk } from '../common/domain/approval-instruction.js'
import type { BuckleConfig } from '../common/runtime/config.js'
import { judgeCachePath } from '../common/services/judge/judge-cache.js'
import { createEnvironmentPack } from '../common/services/packs/environment/index.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { JUDGE_REASONING_LIMIT, type Judge, type JudgeInput, type JudgeResult } from '../common/types/ports/judge.js'
import { configFromEnvironment } from './support/workspace-config.js'

// The decision AI in automated mode (D91, brief item 2 and addendum C): an interpreter call the destructive floor asks
// about is rated once per call, and a safe verdict at 0.8 or above runs it, audited; every other answer asks as before,
// and no deny, built-in floor reason, destructive-list entry, or call the dangerously-allow switch let through is rated.

const roots: string[] = []
const runtimes: BuckleRuntime[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function node(environment: NodeJS.ProcessEnv = {}): BuckleConfig {
  const root = mkdtempSync(join(tmpdir(), 'buckle-judge-auto-'))
  const state = mkdtempSync(join(tmpdir(), 'buckle-judge-auto-state-'))
  roots.push(root, state)
  writeFileSync(join(root, 'job.py'), 'import helper\nprint(helper.VALUE)\n')
  writeFileSync(join(root, 'helper.py'), 'VALUE = 1\n')
  return configFromEnvironment({
    BUCKLE_WORKSPACE_ROOT: root, BUCKLE_STATE_DIR: state,
    BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'true', BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_PACKS: 'fs,shell', BUCKLE_APPROVAL_TIMEOUT_MS: '1',
    BUCKLE_APPROVAL_JUDGE: 'automated', BUCKLE_APPROVAL_JUDGE_PROVIDER: 'openai-compatible', BUCKLE_APPROVAL_JUDGE_MODEL: 'claude-opus-5-5',
    ...environment,
  })
}

/** A judge that answers as `answer` says and records what it was shown. */
function fakeJudge(answer: (input: JudgeInput) => JudgeResult = () => verdict('safe', 0.93)): Judge & { shown: JudgeInput[] } {
  const shown: JudgeInput[] = []
  return { shown, judge: vi.fn(async (input: JudgeInput) => { shown.push(input); return answer(input) }) }
}

function verdict(level: 'safe' | 'warning' | 'danger', confidence: number): JudgeResult {
  return { kind: 'verdict', level, confidence, reasoning: `Rated ${level}.`, model: 'claude-opus-5-5', latencyMs: 40, promptDigest: 'd'.repeat(64) }
}

async function runtimeOf(config: BuckleConfig, judge?: Judge): Promise<BuckleRuntime> {
  const runtime = await createRuntime({ config, ...(judge ? { judge } : {}) })
  runtimes.push(runtime)
  return runtime
}

/** One shell_exec call through the real permission pipeline, with a prepared effect standing in for its arguments; nothing runs. */
async function call(runtime: BuckleRuntime, command: string, args: string[], extra: Array<{ kind: 'write_path'; path: string }> = []) {
  const execute = vi.fn(async () => 'executed')
  const prepare = vi.spyOn(runtime.registry().get('shell_exec'), 'prepare').mockReturnValue({ effects: [{ kind: 'exec', command, args }, ...extra], execute })
  const requestId = `judge-${Math.random()}`
  try {
    const response = await runtime.invoke({ request: { requestId, approvalTokens: [], tool: 'shell_exec', args: {} }, sessionId: 'judge', approvalWait: { mode: 'none' } })
    const entry = runtime.actions.read(200).find(item => item.event === 'result' && item.requestId === requestId)!
    return { response, entry, ran: execute.mock.calls.length > 0 }
  } finally { prepare.mockRestore() }
}

async function withPolicy(runtime: BuckleRuntime, commands: Partial<WorkspacePolicy['commands']>) {
  await runtime.policy.apply({ ...emptyWorkspacePolicy(), commands: { allow: [], deny: [], ...commands } })
}

describe('a safe verdict at 0.8 or above', () => {
  it('runs the call, naming the judge in the audit entry with what it said', async () => {
    const judge = fakeJudge()
    const runtime = await runtimeOf(node(), judge)
    const { response, entry, ran } = await call(runtime, 'python3', ['job.py'])
    expect(response).toMatchObject({ outcome: 'ok' })
    expect(ran).toBe(true)
    expect(judge.judge).toHaveBeenCalledTimes(1)
    expect(judge.shown[0]).toMatchObject({ command: 'python3 job.py', interpreters: ['python3'], files: [{ path: '/workspace/job.py' }, { path: '/workspace/helper.py' }], standardScript: false, cwd: '/workspace' })
    expect(entry.approvedBy).toEqual(['judge'])
    expect(entry.judge).toEqual({ provider: 'openai-compatible', model: 'claude-opus-5-5', level: 'safe', confidence: 0.93, reasoning: 'Rated safe.', latencyMs: 40, promptDigest: 'd'.repeat(64), passed: true, passedBy: 'thorough' })
  })

  it('keeps the standing grants the rest of the call relied on beside the judge', async () => {
    const config = node()
    const runtime = await runtimeOf(config, fakeJudge())
    await runtime.grants.grant({ sessionId: 'judge', rule: 'write_scope', subject: config.cwd, scope: 'always' })
    const { response, entry } = await call(runtime, 'python3', ['job.py'], [{ kind: 'write_path', path: config.cwd }])
    expect(response).toMatchObject({ outcome: 'ok' })
    expect(entry.approvedBy).toEqual(['write_scope', 'judge'])
    expect(entry.grantUses).toEqual([{ rule: 'write_scope', scope: 'always' }])
  })
})

describe('any other answer', () => {
  it.each([
    ['a warning', verdict('warning', 0.95)],
    ['a danger', verdict('danger', 0.99)],
    ['a safe verdict below 0.8', verdict('safe', 0.79)],
    ['no verdict', { kind: 'unavailable', reason: 'the request timed out' } as JudgeResult],
  ])('asks as before after %s, auditing what the judge said', async (_, answer) => {
    const runtime = await runtimeOf(node(), fakeJudge(() => answer))
    const { response, entry, ran } = await call(runtime, 'python3', ['job.py'])
    expect(response).toMatchObject({ outcome: 'approval_required' })
    expect(ran).toBe(false)
    expect(entry.judge).toMatchObject({ provider: 'openai-compatible', model: 'claude-opus-5-5', passed: false, ...(answer.kind === 'verdict' ? { level: answer.level } : { unavailable: 'the request timed out' }) })
  })
})

describe('a reasoning far longer than an audit entry holds', () => {
  const long = 'It reads the build folder. '.repeat(2_600)

  it('is clipped, so a safe pass writes its result entry and a danger answer asks, each entry under the cap', async () => {
    expect(long.length).toBeGreaterThan(70_000)
    const passing = await runtimeOf(node(), fakeJudge(() => ({ ...verdict('safe', 0.95), reasoning: long })))
    const passed = await call(passing, 'python3', ['job.py'])
    expect(passed.ran).toBe(true)
    expect(passed.entry).toBeDefined()
    expect(passed.entry.judge).toMatchObject({ passed: true, reasoning: expect.stringMatching(/\n\[cut\]$/) })
    expect((passed.entry.judge as { reasoning: string }).reasoning).toHaveLength(JUDGE_REASONING_LIMIT)
    expect(Buffer.byteLength(JSON.stringify(passed.entry))).toBeLessThan(65_536)

    const asking = await runtimeOf(node(), fakeJudge(() => ({ ...verdict('danger', 0.95), reasoning: long })))
    const asked = await call(asking, 'python3', ['job.py'])
    expect(asked.response).toMatchObject({ outcome: 'approval_required' })
    expect(Buffer.byteLength(JSON.stringify(asked.entry))).toBeLessThan(65_536)
    expect(asking.approvalService.listing()[0]!.call?.judge?.[0]).toMatchObject({ reasoning: expect.stringMatching(/\n\[cut\]$/) })
  })
})

describe('a long reasoning holding a credential (fix brief 2, R18)', () => {
  it.each([
    ['ending its line', `${'x'.repeat(1_960)}\nDB_PASSWORD=supersecretvalue1234567890ABCDEFGHIJ\n${'y'.repeat(200)}`],
    ['with words after it', `${'x'.repeat(1_960)}\nDB_PASSWORD=supersecretvalue1234567890ABCDEFGHIJ and the rest of the line\n${'y'.repeat(200)}`],
  ])('shows no part of the value where the cut lands inside it, %s', async (_, reasoning) => {
    const runtime = await runtimeOf(node(), fakeJudge(() => ({ ...verdict('danger', 0.95), reasoning })))
    const { response, entry } = await call(runtime, 'python3', ['job.py'])
    expect(response).toMatchObject({ outcome: 'approval_required' })
    const waiting = runtime.approvalService.listing()[0]!
    const line = describeAsk({ ...runtime.approvalService.waitingAsk(waiting.token)!.request, workspaceName: runtime.workspaceName(), call: waiting.call! }).join('\n')
    for (const shown of [JSON.stringify(entry), JSON.stringify(waiting.call?.judge), line]) {
      expect(shown).not.toContain('supersecret')
      expect(shown).toContain('DB_PASSWORD=')
    }
  })
})

describe('code a here-string hands the interpreter', () => {
  it('is read as inline code from bash text, with what it imports', async () => {
    const judge = fakeJudge()
    const runtime = await runtimeOf(node(), judge)
    await withPolicy(runtime, { allow: ['bash -c *'] })
    expect((await call(runtime, 'bash', ['-c', "python3 <<< 'import helper'"])).response).toMatchObject({ outcome: 'ok' })
    expect(judge.shown[0]).toMatchObject({ inline: 'import helper', files: [{ path: '/workspace/helper.py' }] })
  })
})

describe('the packages the code imports', () => {
  const SUMMARY = { score: { overall: 0.8, supplyChain: 0.9, quality: 0.7, maintenance: 0.6, vulnerability: 1, license: 1 }, alerts: [{ type: 'unmaintained', severity: 'low' }] }
  function withPackage(config: BuckleConfig) {
    writeFileSync(join(config.cwd, 'job.js'), "const pad = require('left-pad')\n")
    mkdirSync(join(config.cwd, 'node_modules', 'left-pad'), { recursive: true })
    writeFileSync(join(config.cwd, 'node_modules', 'left-pad', 'package.json'), '{"version":"1.3.0"}')
  }

  it('are shown to the judge with the version installed and Socket\'s summary of it', async () => {
    const config = node()
    withPackage(config)
    const judge = fakeJudge()
    const scanner = { scan: vi.fn(async (purls: readonly string[]) => new Map(purls.map(purl => [purl, SUMMARY]))) }
    const runtime = await createRuntime({ config, judge, packageScanner: scanner })
    runtimes.push(runtime)
    await call(runtime, 'node', ['job.js'])
    expect(scanner.scan.mock.calls[0]![0]).toEqual(['pkg:npm/left-pad@1.3.0'])
    expect(judge.shown[0]!.packages).toEqual([{ name: 'left-pad', version: '1.3.0', socket: SUMMARY }])
  })

  it('carry no Socket summary where the node has no Socket key, and the rating still runs', async () => {
    const config = node()
    withPackage(config)
    const judge = fakeJudge()
    const fetch = vi.spyOn(globalThis, 'fetch')
    const runtime = await runtimeOf(config, judge)
    expect((await call(runtime, 'node', ['job.js'])).response).toMatchObject({ outcome: 'ok' })
    expect(judge.shown[0]!.packages).toEqual([{ name: 'left-pad', version: '1.3.0', socket: null }])
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('code the judge cannot read', () => {
  it('asks, with no request, where the script the interpreter runs names nothing', async () => {
    const judge = fakeJudge()
    const runtime = await runtimeOf(node(), judge)
    const { response, entry, ran } = await call(runtime, 'python3', ['missing.py'])
    expect(response).toMatchObject({ outcome: 'approval_required' })
    expect(ran).toBe(false)
    expect(judge.judge).not.toHaveBeenCalled()
    expect(entry.judge).toMatchObject({ unavailable: 'the code the interpreter runs was not found', passed: false })
  })

  it('asks, naming no path, where reading it throws, as at a hard link on the disk that holds Buckle\'s state', async () => {
    const judge = fakeJudge()
    const config = node()
    linkSync(join(config.cwd, 'job.py'), join(config.cwd, 'job-link.py'))
    const runtime = await runtimeOf(config, judge)
    const { response, entry, ran } = await call(runtime, 'python3', ['job.py'])
    expect(response).toMatchObject({ outcome: 'approval_required' })
    expect(ran).toBe(false)
    expect(judge.judge).not.toHaveBeenCalled()
    expect(entry.judge).toMatchObject({ unavailable: 'the code could not be read', passed: false })
    expect(JSON.stringify(response)).not.toContain(config.cwd)
  })
})

describe('what the judge never rates', () => {
  it('a call under a deny glob, which is refused before any ask', async () => {
    const judge = fakeJudge()
    const runtime = await runtimeOf(node(), judge)
    await withPolicy(runtime, { deny: ['terraform destroy *'] })
    expect((await call(runtime, 'python3', ['job.py'])).response).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED' } })
    expect(judge.judge).not.toHaveBeenCalled()
  })

  it('a built-in floor reason, such as sudo', async () => {
    const judge = fakeJudge()
    const runtime = await runtimeOf(node(), judge)
    expect((await call(runtime, 'sudo', ['python3', 'job.py'])).response).toMatchObject({ outcome: 'approval_required' })
    expect(judge.judge).not.toHaveBeenCalled()
  })

  it('a call the workspace\'s destructive list names', async () => {
    const judge = fakeJudge()
    const runtime = await runtimeOf(node(), judge)
    await withPolicy(runtime, { destructive: ['python3 *'] })
    expect((await call(runtime, 'python3', ['job.py'])).response).toMatchObject({ outcome: 'approval_required' })
    expect(judge.judge).not.toHaveBeenCalled()
  })

  it('a call the dangerously-allow switch already lets through', async () => {
    const judge = fakeJudge()
    const runtime = await runtimeOf(node(), judge)
    await runtime.policy.setDangerouslyAllow(true)
    expect((await call(runtime, 'python3', ['job.py'])).response).toMatchObject({ outcome: 'ok' })
    expect(judge.judge).not.toHaveBeenCalled()
  })

  it('anything in a workspace whose judge is on-request, or whose node holds no key', async () => {
    const judge = fakeJudge()
    const runtime = await runtimeOf(node({ BUCKLE_APPROVAL_JUDGE: 'on-request' }), judge)
    const { response, entry } = await call(runtime, 'python3', ['job.py'])
    expect(response).toMatchObject({ outcome: 'approval_required' })
    expect(judge.judge).not.toHaveBeenCalled()
    expect(entry.judge).toBeUndefined()
    // No key and no judge handed in: nothing is asked of any provider.
    const fetch = vi.spyOn(globalThis, 'fetch')
    const keyless = await runtimeOf(node())
    expect((await call(keyless, 'python3', ['job.py'])).response).toMatchObject({ outcome: 'approval_required' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('code past what it reads: the call asks with no request', async () => {
    const config = node()
    writeFileSync(join(config.cwd, 'big.py'), 'x = 1\n'.repeat(100_000))
    const judge = fakeJudge()
    const runtime = await runtimeOf(config, judge)
    const { response, entry } = await call(runtime, 'python3', ['big.py'])
    expect(response).toMatchObject({ outcome: 'approval_required' })
    expect(judge.judge).not.toHaveBeenCalled()
    expect(entry.judge).toMatchObject({ unavailable: 'the code closure exceeds what the judge reads', passed: false })
  })
})

describe('a host path Buckle supplies itself', () => {
  it('is shown to no stage: a script_run node call names node, never Buckle\'s own binary', async () => {
    const judge = fakeJudge(() => verdict('danger', 0.95))
    const runtime = await runtimeOf(node(), judge)
    const response = await runtime.invoke({ request: { requestId: 'script-node', approvalTokens: [], tool: 'script_run', args: { runtime: 'node', script: 'console.log(1)' } }, sessionId: 'judge', approvalWait: { mode: 'none' } })
    expect(response).toMatchObject({ outcome: 'approval_required' })
    expect(judge.judge).toHaveBeenCalledTimes(1)
    expect(judge.shown[0]).toMatchObject({ command: "node --input-type=module --eval 'console.log(1)'", argv: ['node', '--input-type=module', '--eval', 'console.log(1)'], inline: 'console.log(1)' })
    expect(JSON.stringify(judge.shown[0])).not.toContain(process.execPath)
  })

  it('names the owner\'s validator by its basename to a stage, while the rules and approvers keep its path', () => {
    const pack = createEnvironmentPack({ command: '/opt/tools/varlock', validator: { path: null, reason: 'not used here' } as never, cwd: tmpdir(), runProcess: vi.fn() as never, environment: () => ({}) })
    expect(pack.tools[0]!.prepare({}).effects).toEqual([{ kind: 'exec', command: '/opt/tools/varlock', args: ['load', '--agent'], shownAs: 'varlock' }])
  })
})

describe('a standard development script', () => {
  it('is rated on its command line alone', async () => {
    const judge = fakeJudge(input => ({ ...verdict('safe', 0.9), reasoning: input.command }))
    const runtime = await runtimeOf(node(), judge)
    expect((await call(runtime, 'npx', ['vitest', 'run'])).response).toMatchObject({ outcome: 'ok' })
    expect(judge.shown[0]).toMatchObject({ command: 'npx vitest run', standardScript: true, files: [], inline: null })
  })
})

describe('the verdict cache', () => {
  it('answers the same command and code again without a request, until a file changes or the policy changes, and across a restart', async () => {
    const config = node()
    const judge = fakeJudge()
    const runtime = await runtimeOf(config, judge)
    await call(runtime, 'python3', ['job.py'])
    expect((await call(runtime, 'python3', ['job.py'])).response).toMatchObject({ outcome: 'ok' })
    expect(judge.judge).toHaveBeenCalledTimes(1)

    writeFileSync(join(config.cwd, 'helper.py'), 'VALUE = 2\n')
    await call(runtime, 'python3', ['job.py'])
    expect(judge.judge).toHaveBeenCalledTimes(2)

    const kept = () => (JSON.parse(readFileSync(judgeCachePath(config.stateDirectory), 'utf8')) as { entries: unknown[] }).entries.length
    expect(kept()).toBe(2)
    await withPolicy(runtime, { allow: [], destructive: ['terraform destroy *'] })
    // A new policy empties the cache, so only what is rated under it is kept.
    expect(kept()).toBe(0)
    await call(runtime, 'python3', ['job.py'])
    expect(judge.judge).toHaveBeenCalledTimes(3)
    expect(kept()).toBe(1)

    const restarted = await runtimeOf(config, judge)
    expect((await call(restarted, 'python3', ['job.py'])).response).toMatchObject({ outcome: 'ok' })
    expect(judge.judge).toHaveBeenCalledTimes(3)
  })

  it('rates two files again once they swap contents, though every sha is the same', async () => {
    const config = node()
    const judge = fakeJudge()
    writeFileSync(join(config.cwd, 'a.py'), 'import sys\nprint(sys.argv[1])\n')
    writeFileSync(join(config.cwd, 'b.py'), 'import shutil\nshutil.rmtree("/data")\n')
    const runtime = await runtimeOf(config, judge)
    expect((await call(runtime, 'python3', ['a.py', 'b.py'])).ran).toBe(true)
    writeFileSync(join(config.cwd, 'a.py'), 'import shutil\nshutil.rmtree("/data")\n')
    writeFileSync(join(config.cwd, 'b.py'), 'import sys\nprint(sys.argv[1])\n')
    await call(runtime, 'python3', ['a.py', 'b.py'])
    expect(judge.judge).toHaveBeenCalledTimes(2)
  })

  it('keeps no unavailable rating', async () => {
    let answer: JudgeResult = { kind: 'unavailable', reason: 'the network failed' }
    const judge = fakeJudge(() => answer)
    const runtime = await runtimeOf(node(), judge)
    await call(runtime, 'python3', ['job.py'])
    answer = verdict('safe', 0.9)
    expect((await call(runtime, 'python3', ['job.py'])).response).toMatchObject({ outcome: 'ok' })
    expect(judge.judge).toHaveBeenCalledTimes(2)
  })
})
