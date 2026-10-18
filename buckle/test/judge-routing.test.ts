import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyWorkspacePolicy, type WorkspacePolicy } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BuckleConfig } from '../common/runtime/config.js'
import { logger } from '../common/runtime/log.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import type { Judge, JudgeInput, JudgeLevel, JudgeResult } from '../common/types/ports/judge.js'
import { QUICK_STATE_BUDGET_BYTES, type QuickJudge, type QuickResult } from '../common/types/ports/quick-judge.js'
import { configFromEnvironment } from './support/workspace-config.js'

// The decision AI's two stages in automated mode (D91, addendum 2 B), row by row: Jev's safe at 0.8 or above runs the
// call; Jev's danger at 0.8 or above goes to a person with no thorough call; anything else goes to the thorough stage for
// an interpreter ask or an ask Jev rated, and otherwise to a person. A deny is never rated and never lifted.

const roots: string[] = []
const runtimes: BuckleRuntime[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function node(environment: NodeJS.ProcessEnv = {}): BuckleConfig {
  const root = mkdtempSync(join(tmpdir(), 'buckle-judge-route-'))
  const state = mkdtempSync(join(tmpdir(), 'buckle-judge-route-state-'))
  roots.push(root, state)
  writeFileSync(join(root, 'job.py'), 'print(1)\n')
  return configFromEnvironment({
    BUCKLE_WORKSPACE_ROOT: root, BUCKLE_STATE_DIR: state,
    BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'true', BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_PACKS: 'fs,shell', BUCKLE_APPROVAL_TIMEOUT_MS: '1',
    BUCKLE_APPROVAL_JUDGE: 'automated', BUCKLE_APPROVAL_QUICK_JUDGE: 'interpreters',
    ...environment,
  })
}

function thorough(level: JudgeLevel, confidence: number): JudgeResult {
  return { kind: 'verdict', level, confidence, reasoning: `Rated ${level}.`, model: 'gpt-6-luna', latencyMs: 900, promptDigest: 'd'.repeat(64) }
}

function quick(level: JudgeLevel, confidence: number): QuickResult {
  const rest = (1 - confidence) / 2
  return { kind: 'verdict', level, confidence, probabilities: { safe: rest, warning: rest, danger: rest, [level]: confidence } as Record<JudgeLevel, number>, model: 'jev-1.13.0', latencyMs: 120 }
}

const NO_QUICK: QuickResult = { kind: 'unavailable', reason: 'the request timed out' }

function judges(answers: { quick?: QuickResult; thorough?: JudgeResult }) {
  const shownQuick: JudgeInput[] = []
  const shownThorough: JudgeInput[] = []
  const quickJudge: QuickJudge = { quick: vi.fn(async (input: JudgeInput) => { shownQuick.push(input); return answers.quick ?? NO_QUICK }) }
  const judge: Judge = { judge: vi.fn(async (input: JudgeInput) => { shownThorough.push(input); return answers.thorough ?? thorough('danger', 0.9) }) }
  return { quickJudge, judge, shownQuick, shownThorough }
}

async function runtimeOf(config: BuckleConfig, fakes: { judge: Judge; quickJudge: QuickJudge }): Promise<BuckleRuntime> {
  const runtime = await createRuntime({ config, ...fakes })
  runtimes.push(runtime)
  return runtime
}

async function call(runtime: BuckleRuntime, command: string, args: string[]) {
  const execute = vi.fn(async () => 'executed')
  const prepare = vi.spyOn(runtime.registry().get('shell_exec'), 'prepare').mockReturnValue({ effects: [{ kind: 'exec', command, args }], execute })
  const requestId = `route-${Math.random()}`
  try {
    const response = await runtime.invoke({ request: { requestId, approvalTokens: [], tool: 'shell_exec', args: {} }, sessionId: 'route', approvalWait: { mode: 'none' } })
    const entry = runtime.actions.read(200).find(item => item.event === 'result' && item.requestId === requestId)!
    const waiting = runtime.approvalService.listing().find(item => item.tool === 'shell_exec')
    return { response, entry, ran: execute.mock.calls.length > 0, waiting }
  } finally { prepare.mockRestore() }
}

async function withPolicy(runtime: BuckleRuntime, commands: Partial<WorkspacePolicy['commands']>) {
  await runtime.policy.apply({ ...emptyWorkspacePolicy(), commands: { allow: [], deny: [], ...commands } })
}

describe('a call a stage passed', () => {
  it('prints one info line naming the stage, the model, the level, the confidence, and the command as an approver sees it; none for an ask', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
    const passes = () => info.mock.calls.filter(([message]) => String(message).startsWith('The decision AI'))
    const args = ['job.py', 'https://me:hunter2@example.com/x']
    await call(await runtimeOf(node(), judges({ quick: quick('safe', 0.93) })), 'python3', args)
    await call(await runtimeOf(node(), judges({ thorough: thorough('safe', 0.9) })), 'python3', args)
    expect(passes()).toEqual([
      ['The decision AI\'s quick stage rated a command safe, so it runs without asking', { stage: 'quick', model: 'jev-1.13.0', level: 'safe', confidence: 0.93, subject: expect.stringMatching(/^python3 job\.py .*\[redacted\]/) }],
      ['The decision AI\'s thorough stage rated a command safe, so it runs without asking', { stage: 'thorough', model: 'gpt-6-luna', level: 'safe', confidence: 0.9, subject: expect.stringMatching(/^python3 job\.py .*\[redacted\]/) }],
    ])
    expect(JSON.stringify(passes())).not.toContain('hunter2')
    info.mockClear()
    await call(await runtimeOf(node(), judges({ quick: quick('danger', 0.95) })), 'python3', args)
    expect(passes()).toEqual([])
  })

  it('says the call still waits, naming the rules left, where another ask remains (fix brief 2, H9 and H13)', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
    const passes = () => info.mock.calls.filter(([message]) => String(message).startsWith('The decision AI')).map(([message]) => message)
    const runtime = await runtimeOf(node({ BUCKLE_APPROVAL_QUICK_JUDGE: 'off' }), judges({ thorough: thorough('safe', 0.95) }))
    const execute = vi.fn(async () => 'executed')
    const effects = [{ kind: 'exec' as const, command: 'python3', args: ['job.py'] }, { kind: 'write_path' as const, path: 'out/result.txt' }, { kind: 'exec' as const, command: 'rm', args: ['-rf', 'build'] }]
    vi.spyOn(runtime.registry().get('shell_exec'), 'prepare').mockReturnValue({ effects, execute })
    const response = await runtime.invoke({ request: { requestId: 'waits', approvalTokens: [], tool: 'shell_exec', args: {} }, sessionId: 'route', approvalWait: { mode: 'none' } })
    expect(response).toMatchObject({ outcome: 'approval_required' })
    expect(execute).not.toHaveBeenCalled()
    expect(passes()).toEqual(['The decision AI\'s thorough stage rated a command safe, and the call still waits for destructive_command and write_scope'])
  })
})

describe('a standard script', () => {
  /** What the quick stage was shown of each call, under scope asks, which rates the floor's asks too. */
  async function shown(calls: Array<[string, string[]]>) {
    const config = node({ BUCKLE_APPROVAL_QUICK_JUDGE: 'asks' })
    writeFileSync(join(config.cwd, 'deploy.ts'), 'export {}\n')
    const fakes = judges({ quick: quick('danger', 0.95) })
    const runtime = await runtimeOf(config, fakes)
    for (const [command, args] of calls) await call(runtime, command, args)
    return fakes.shownQuick.map(input => [input.command, input.standardScript, input.files.map(file => file.path)])
  }

  it('is never bun run naming a file: its code is read as bun <file>\'s is', async () => {
    expect(await shown([['bun', ['run', './deploy.ts']], ['bun', ['run', 'deploy.ts']]])).toEqual([
      ['bun run ./deploy.ts', false, ['/workspace/deploy.ts']],
      ['bun run deploy.ts', false, ['/workspace/deploy.ts']],
    ])
  })

  it('is never a call behind a privilege wrapper, whatever its inner form matches', async () => {
    expect(await shown([['sudo', ['npx', 'vitest', 'run']], ['sudo', ['bun', 'run', './deploy.ts']]])).toEqual([
      ['sudo npx vitest run', false, []],
      ['sudo bun run ./deploy.ts', false, ['/workspace/deploy.ts']],
    ])
  })

  /** Per call, what the quick stage was shown (its standard flag and files), or that it was not shown, the code not read. */
  async function standardOf(calls: Array<[string, string[]]>, shellCalls: Array<[string, string[]]> = []) {
    const config = node({ BUCKLE_APPROVAL_QUICK_JUDGE: 'asks' })
    writeFileSync(join(config.cwd, 'deploy.ts'), 'export {}\n')
    writeFileSync(join(config.cwd, 'deployx'), 'console.log(1)\n')
    const fakes = judges({ quick: quick('danger', 0.95) })
    const runtime = await runtimeOf(config, fakes)
    const seen: unknown[] = []
    const each = async ([command, args]: [string, string[]]) => {
      const before = fakes.shownQuick.length
      const { entry } = await call(runtime, command, args)
      const input = fakes.shownQuick[before]
      seen.push(input ? [input.command, input.standardScript, input.files.map(file => file.path)] : [[command, ...args].join(' '), 'not shown', entry?.judge && 'quick' in entry.judge ? entry.judge.quick : undefined])
    }
    for (const item of calls) await each(item)
    if (shellCalls.length > 0) await withPolicy(runtime, { allow: ['bash -c *'] })
    for (const item of shellCalls) await each(item)
    return seen
  }

  it('skips the value of a bun run option before taking the operand, so bun run --port 3000 ./deploy.ts is read (fix brief 2, R15)', async () => {
    expect(await standardOf([['bun', ['run', '--conditions', 'development', 'deploy.ts']], ['bun', ['run', '-d', 'X:1', 'deploy.ts']], ['bun', ['run', '--port', '3000', './deploy.ts']], ['bun', ['run', '--cwd', 'sub', 'deploy.ts']]])).toEqual([
      ['bun run --conditions development deploy.ts', false, ['/workspace/deploy.ts']],
      ['bun run -d X:1 deploy.ts', false, ['/workspace/deploy.ts']],
      ['bun run --port 3000 ./deploy.ts', false, ['/workspace/deploy.ts']],
      ['bun run --cwd sub deploy.ts', 'not shown', { provider: 'typesafe', model: 'jev-latest', unavailable: 'the call changes its working directory before the code runs' }],
    ])
  })

  it('counts each sign of a file alone: a slash, a script extension, or a file the view finds (fix brief 2, R15 and H10)', async () => {
    const notFound = { provider: 'typesafe', model: 'jev-latest', unavailable: 'the code the interpreter runs was not found' }
    expect(await standardOf([['bun', ['run', './missing']], ['bun', ['run', 'missing.ts']], ['bun', ['run', 'deployx']]])).toEqual([
      ['bun run ./missing', 'not shown', notFound],
      ['bun run missing.ts', 'not shown', notFound],
      ['bun run deployx', false, ['/workspace/deployx']],
    ])
  })

  it('is never standard behind any privilege wrapper: doas, su, pkexec, or runas (fix brief 2, H10)', async () => {
    const notFound = { provider: 'typesafe', model: 'jev-latest', unavailable: 'the code the interpreter runs was not found' }
    const shellText = { provider: 'typesafe', model: 'jev-latest', unavailable: 'shell text the reader does not rate whole' }
    expect(await standardOf([['doas', ['bun', 'run', 'dev']], ['su', ['-c', 'bun run dev', 'root']]], [['bash', ['-c', 'bun run dev; pkexec true']], ['bash', ['-c', 'bun run dev; runas /user:admin true']]])).toEqual([
      ['doas bun run dev', 'not shown', notFound],
      // Text a shell runs is read only as one simple command a POSIX-family shell runs (fix brief 4, P).
      ['su -c bun run dev root', 'not shown', shellText],
      ['bash -c bun run dev; pkexec true', 'not shown', shellText],
      ['bash -c bun run dev; runas /user:admin true', 'not shown', shellText],
    ])
  })

  it('reads what bun loads before a standard script: its preload options and its bunfig.toml\'s, and refuses a missing one (fix brief 3, R15)', async () => {
    const seenOf = async (files: Record<string, string>, calls: Array<[string, string[]]>) => {
      const config = node({ BUCKLE_APPROVAL_QUICK_JUDGE: 'asks' })
      for (const [name, content] of Object.entries(files)) writeFileSync(join(config.cwd, name), content)
      const fakes = judges({ quick: quick('danger', 0.95) })
      const runtime = await runtimeOf(config, fakes)
      const seen: unknown[] = []
      for (const [command, args] of calls) {
        const before = fakes.shownQuick.length
        const { entry } = await call(runtime, command, args)
        const input = fakes.shownQuick[before]
        const note = (entry?.judge as { quick?: { unavailable?: string } } | undefined)?.quick
        seen.push(input ? [input.command, input.standardScript, input.files.map(file => file.path)] : [[command, ...args].join(' '), 'not shown', note?.unavailable])
      }
      return seen
    }
    expect(await seenOf({ 'setup.js': "require('./helper.js')\n", 'helper.js': 'module.exports = 1\n' }, [['bun', ['run', '-r', './setup.js', 'dev']], ['bun', ['run', '--preload=./setup.js', 'dev']], ['bun', ['run', '-r', './missing.js', 'dev']]])).toEqual([
      ['bun run -r ./setup.js dev', true, ['/workspace/setup.js', '/workspace/helper.js']],
      ['bun run --preload=./setup.js dev', true, ['/workspace/setup.js', '/workspace/helper.js']],
      ['bun run -r ./missing.js dev', 'not shown', 'the code the interpreter runs was not found'],
    ])
    expect(await seenOf({ 'bunfig.toml': 'preload = ["./pre.ts"]\n', 'pre.ts': 'export {}\n' }, [['bun', ['run', 'dev']]])).toEqual([['bun run dev', true, ['/workspace/pre.ts']]])
    expect(await seenOf({ 'bunfig.toml': 'preload = ["./gone.ts"]\n' }, [['bun', ['run', 'dev']]])).toEqual([['bun run dev', 'not shown', 'the code the interpreter runs was not found']])
    expect(await seenOf({ 'bunfig.toml': 'preload = [1]\n' }, [['bun', ['run', 'dev']]])).toEqual([['bun run dev', 'not shown', 'a config file the reader could not parse']])
    // An option the reader does not know, or a config it does not place, could hide a preload, so the call asks (fix brief 4, R15).
    expect(await seenOf({ 'setup.js': 'module.exports = 1\n' }, [['bun', ['run', '--drop', 'console', '-r', './setup.js', 'dev']], ['bun', ['run', '-r./setup.js', 'dev']], ['bun', ['run', '-c', 'conf/bunfig.toml', 'dev']]])).toEqual([
      ['bun run --drop console -r ./setup.js dev', 'not shown', 'an option the reader does not know'],
      ['bun run -r./setup.js dev', 'not shown', 'an option the reader does not know'],
      ['bun run -c conf/bunfig.toml dev', 'not shown', 'an option the reader does not know'],
    ])
    expect(await seenOf({ 'alt.toml': 'preload = ["./setup.js"]\n', 'setup.js': 'module.exports = 1\n' }, [['bun', ['run', '--config=alt.toml', 'dev']]])).toEqual([['bun run --config=alt.toml dev', true, ['/workspace/setup.js']]])
  })

  it('still matches on the inner form behind a wrapper that runs as the same user', async () => {
    expect(await shown([['timeout', ['60', 'bun', 'run', 'dev']]])).toEqual([['timeout 60 bun run dev', true, []]])
  })
})

describe('an interpreter ask, with the quick stage on', () => {
  it('runs on Jev\'s safe at 0.8 or above, with no thorough call, naming the quick stage in the audit entry', async () => {
    const fakes = judges({ quick: quick('safe', 0.93) })
    const { response, entry, ran } = await call(await runtimeOf(node(), fakes), 'python3', ['job.py'])
    expect(response).toMatchObject({ outcome: 'ok' })
    expect(ran).toBe(true)
    expect(fakes.judge.judge).not.toHaveBeenCalled()
    expect(fakes.shownQuick[0]).toMatchObject({ command: 'python3 job.py', files: [{ path: '/workspace/job.py' }] })
    expect(entry.approvedBy).toEqual(['judge'])
    expect(entry.judge).toEqual({ quick: { provider: 'typesafe', model: 'jev-1.13.0', level: 'safe', confidence: 0.93, probabilities: expect.any(Object), latencyMs: 120 }, passed: true, passedBy: 'quick' })
  })

  it('asks on Jev\'s danger at 0.8 or above, with no thorough call, the verdict beside the action', async () => {
    const fakes = judges({ quick: quick('danger', 0.88) })
    const { response, entry, waiting } = await call(await runtimeOf(node(), fakes), 'python3', ['job.py'])
    expect(response).toMatchObject({ outcome: 'approval_required' })
    expect(fakes.judge.judge).not.toHaveBeenCalled()
    expect(entry.judge).toMatchObject({ quick: { level: 'danger', confidence: 0.88 }, passed: false })
    expect(waiting?.call?.judge).toEqual([{ subject: expect.any(String), quick: { level: 'danger', confidence: 0.88, model: 'jev-1.13.0', latencyMs: 120 } }])
  })

  it.each([
    ['a warning', quick('warning', 0.95)],
    ['a safe below 0.8', quick('safe', 0.79)],
    ['a danger below 0.8', quick('danger', 0.6)],
    ['no verdict', NO_QUICK],
  ])('goes to the thorough stage after %s, which runs it on its own safe verdict', async (_, answer) => {
    const fakes = judges({ quick: answer, thorough: thorough('safe', 0.91) })
    const { response, entry } = await call(await runtimeOf(node(), fakes), 'python3', ['job.py'])
    expect(response).toMatchObject({ outcome: 'ok' })
    expect(fakes.judge.judge).toHaveBeenCalledTimes(1)
    expect(entry.judge).toMatchObject({ provider: 'openai-compatible', level: 'safe', passed: true, passedBy: 'thorough', quick: answer.kind === 'verdict' ? { level: answer.level } : { unavailable: answer.reason } })
  })

  it('asks with both verdicts beside the action where the thorough stage does not pass it', async () => {
    const fakes = judges({ quick: quick('warning', 0.9), thorough: thorough('danger', 0.97) })
    const { response, waiting } = await call(await runtimeOf(node(), fakes), 'python3', ['job.py'])
    expect(response).toMatchObject({ outcome: 'approval_required' })
    expect(waiting?.call?.judge).toEqual([{ subject: expect.any(String), level: 'danger', confidence: 0.97, model: 'gpt-6-luna', reasoning: 'Rated danger.', latencyMs: 900, quick: { level: 'warning', confidence: 0.9, model: 'jev-1.13.0', latencyMs: 120 } }])
  })

  it(`skips Jev for a call over ${QUICK_STATE_BUDGET_BYTES} bytes, and the thorough stage rates it`, async () => {
    const config = node()
    writeFileSync(join(config.cwd, 'job.py'), `# ${'x'.repeat(QUICK_STATE_BUDGET_BYTES)}\nprint(1)\n`)
    const fakes = judges({ quick: quick('safe', 0.99), thorough: thorough('warning', 0.9) })
    const { response, entry } = await call(await runtimeOf(config, fakes), 'python3', ['job.py'])
    expect(response).toMatchObject({ outcome: 'approval_required' })
    expect(fakes.quickJudge.quick).not.toHaveBeenCalled()
    expect(fakes.judge.judge).toHaveBeenCalledTimes(1)
    expect(entry.judge).toMatchObject({ level: 'warning', quick: { unavailable: 'the call is larger than the quick stage reads' } })
  })

  it('keeps each stage\'s verdict apart in the cache, so the next identical call asks neither', async () => {
    const fakes = judges({ quick: quick('warning', 0.9), thorough: thorough('danger', 0.97) })
    const runtime = await runtimeOf(node(), fakes)
    await call(runtime, 'python3', ['job.py'])
    const again = await call(runtime, 'python3', ['job.py'])
    expect(fakes.quickJudge.quick).toHaveBeenCalledTimes(1)
    expect(fakes.judge.judge).toHaveBeenCalledTimes(1)
    expect(again.entry.judge).toMatchObject({ level: 'danger', quick: { level: 'warning' } })
  })
})

describe('a standard development script', () => {
  it('reaches each stage as a standard script, on its command line alone, for npm, pnpm, and yarn as for npx', async () => {
    const fakes = judges({ quick: quick('warning', 0.9), thorough: thorough('safe', 0.95) })
    const runtime = await runtimeOf(node({ BUCKLE_APPROVAL_QUICK_JUDGE: 'asks' }), fakes)
    await withPolicy(runtime, { destructive: ['npm run *', 'pnpm dev', 'yarn build'] })
    for (const [command, args] of [['npm', ['run', 'dev']], ['pnpm', ['dev']], ['yarn', ['build']]] as const) {
      expect((await call(runtime, command, [...args])).response, command).toMatchObject({ outcome: 'ok' })
    }
    expect(fakes.shownQuick.map(item => [item.command, item.standardScript, item.files])).toEqual([['npm run dev', true, []], ['pnpm dev', true, []], ['yarn build', true, []]])
    expect(fakes.shownThorough.map(item => item.standardScript)).toEqual([true, true, true])
  })
})

describe('the quick stage\'s scope', () => {
  it('interpreters: an ask the built-in floor makes is left to a person', async () => {
    const fakes = judges({ quick: quick('safe', 0.99), thorough: thorough('safe', 0.99) })
    const { response } = await call(await runtimeOf(node(), fakes), 'sudo', ['ls'])
    expect(response).toMatchObject({ outcome: 'approval_required' })
    expect(fakes.quickJudge.quick).not.toHaveBeenCalled()
    expect(fakes.judge.judge).not.toHaveBeenCalled()
  })

  it('asks: Jev rates a floor or destructive-list ask, and its safe runs the call', async () => {
    const fakes = judges({ quick: quick('safe', 0.9) })
    const runtime = await runtimeOf(node({ BUCKLE_APPROVAL_QUICK_JUDGE: 'asks' }), fakes)
    await withPolicy(runtime, { destructive: ['make clean'] })
    const listed = await call(runtime, 'make', ['clean'])
    expect(listed.response).toMatchObject({ outcome: 'ok' })
    expect(listed.entry.judge).toMatchObject({ quick: { level: 'safe' }, passedBy: 'quick' })
    expect(fakes.judge.judge).not.toHaveBeenCalled()
  })

  it('asks: a floor ask Jev cannot rate goes to a person, and one it rates without settling goes to the thorough stage', async () => {
    const unrated = judges({ quick: NO_QUICK, thorough: thorough('safe', 0.99) })
    expect((await call(await runtimeOf(node({ BUCKLE_APPROVAL_QUICK_JUDGE: 'asks' }), unrated), 'sudo', ['ls'])).response).toMatchObject({ outcome: 'approval_required' })
    expect(unrated.judge.judge).not.toHaveBeenCalled()

    const escalated = judges({ quick: quick('warning', 0.9), thorough: thorough('safe', 0.95) })
    const { response, entry } = await call(await runtimeOf(node({ BUCKLE_APPROVAL_QUICK_JUDGE: 'asks' }), escalated), 'sudo', ['ls'])
    expect(response).toMatchObject({ outcome: 'ok' })
    expect(escalated.judge.judge).toHaveBeenCalledTimes(1)
    expect(entry.judge).toMatchObject({ level: 'safe', passedBy: 'thorough', quick: { level: 'warning' } })
  })

  it('never rates or lifts a deny', async () => {
    const fakes = judges({ quick: quick('safe', 0.99), thorough: thorough('safe', 0.99) })
    const runtime = await runtimeOf(node({ BUCKLE_APPROVAL_QUICK_JUDGE: 'asks' }), fakes)
    await withPolicy(runtime, { deny: ['sudo *'] })
    expect((await call(runtime, 'sudo', ['ls'])).response).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED' } })
    expect(fakes.quickJudge.quick).not.toHaveBeenCalled()
    expect(fakes.judge.judge).not.toHaveBeenCalled()
  })

  it('off, or with no quick key: the thorough stage alone, as before', async () => {
    const fakes = judges({ quick: quick('safe', 0.99), thorough: thorough('danger', 0.9) })
    await call(await runtimeOf(node({ BUCKLE_APPROVAL_QUICK_JUDGE: 'off' }), fakes), 'python3', ['job.py'])
    expect(fakes.quickJudge.quick).not.toHaveBeenCalled()
    expect(fakes.judge.judge).toHaveBeenCalledTimes(1)
  })
})
