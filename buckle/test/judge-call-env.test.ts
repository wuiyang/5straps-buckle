import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyWorkspacePolicy, type JsonObject } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BuckleConfig } from '../common/runtime/config.js'
import { callVariables, CODE_LOADING_VARIABLES, codeLoadingReason, codeLoadingVariable, joinedVariables, MAX_SHOWN_VARIABLES, shownVariables } from '../common/services/judge/call-env.js'
import { assignedVariables, CHANGES_DIRECTORY, changesDirectory } from '../common/services/judge/call-forms.js'
import { commandForms, commandFormsOf } from '../common/domain/command-forms.js'
import { judgeCacheKey } from '../common/services/judge/judge-cache.js'
import { clippedReason, UNREAD_REASON_LIMIT } from '../common/services/judge/judge-gate.js'
import { SHELL_TEXT_REFUSAL } from '../common/services/judge/shell-statement.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import type { Judge, JudgeInput, JudgeResult } from '../common/types/ports/judge.js'
import type { QuickJudge } from '../common/types/ports/quick-judge.js'
import { configFromEnvironment } from './support/workspace-config.js'

// The variables a call sets for its command (D91, fix brief 1 item 14): one that changes what code runs means no rating,
// so the call asks a person, and under scope all nothing is screened; every other variable reaches both stages, its value
// as the agent gave it with a secret's hidden, and is part of the cache key, so a verdict never covers a call it did not see.

const roots: string[] = []
const runtimes: BuckleRuntime[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function node(environment: NodeJS.ProcessEnv = {}): BuckleConfig {
  const root = mkdtempSync(join(tmpdir(), 'buckle-judge-env-'))
  const state = mkdtempSync(join(tmpdir(), 'buckle-judge-env-state-'))
  roots.push(root, state)
  writeFileSync(join(root, 'build.js'), "require('fs').writeFileSync('built.txt', 'ok')\n")
  writeFileSync(join(root, 'evil.js'), "require('fs').writeFileSync('pwned.txt', 'ok')\n")
  return configFromEnvironment({
    BUCKLE_WORKSPACE_ROOT: root, BUCKLE_STATE_DIR: state,
    BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'true', BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_PACKS: 'fs,shell', BUCKLE_APPROVAL_TIMEOUT_MS: '60000',
    BUCKLE_APPROVAL_JUDGE: 'automated',
    ...environment,
  })
}

const SAFE: JudgeResult = { kind: 'verdict', level: 'safe', confidence: 0.95, reasoning: 'Builds the project.', model: 'gpt-6-luna', latencyMs: 40, promptDigest: 'd'.repeat(64) }

function fakeJudge(answer: JudgeResult = SAFE): Judge & { shown: JudgeInput[] } {
  const shown: JudgeInput[] = []
  return { shown, judge: vi.fn(async (input: JudgeInput) => { shown.push(input); return answer }) }
}

async function runtimeOf(config: BuckleConfig, judges: { judge?: Judge; quickJudge?: QuickJudge }): Promise<BuckleRuntime> {
  const runtime = await createRuntime({ config, ...judges })
  runtimes.push(runtime)
  return runtime
}

/** One shell_exec call (`node build.js` unless named) with the arguments given, through the real permission pipeline; nothing runs. */
async function call(runtime: BuckleRuntime, args: JsonObject = {}, command = ['node', 'build.js']) {
  const execute = vi.fn(async () => 'executed')
  const [program = '', ...words] = command
  const prepare = vi.spyOn(runtime.registry().get('shell_exec'), 'prepare').mockReturnValue({ effects: [{ kind: 'exec', command: program, args: words }], execute })
  const requestId = `env-${Math.random()}`
  try {
    const response = await runtime.invoke({ request: { requestId, approvalTokens: [], tool: 'shell_exec', args: { command: program, args: words, ...args } }, sessionId: 'env', approvalWait: { mode: 'none' } })
    const entry = runtime.actions.read(200).find(item => item.event === 'result' && item.requestId === requestId)!
    return { response, entry, ran: execute.mock.calls.length > 0 }
  } finally { prepare.mockRestore() }
}

describe('the variables that change what code runs', () => {
  it('are the names and prefixes fix brief 1 lists', () => {
    expect(CODE_LOADING_VARIABLES).toEqual({
      names: ['PATH', 'IFS', 'ENV', 'BASH_ENV', 'ZDOTDIR', 'SHELLOPTS', 'BASHOPTS', 'CDPATH', 'GCONV_PATH', 'GLIBC_TUNABLES', 'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'PHP_INI_SCAN_DIR', 'PHPRC', 'GOFLAGS', 'GOPATH', 'GOROOT', 'SHELL', 'HOME'],
      prefixes: ['LD_', 'DYLD_', 'NODE_', 'PYTHON', 'PERL', 'RUBY', 'GEM_', 'BUN_', 'DENO_', 'BASH_FUNC_'],
    })
  })

  it('are found by name or prefix, as Windows reads a name, and named without their value', () => {
    const named = (env: Record<string, string>) => codeLoadingVariable(callVariables({ env }))
    // PYTHONPYCACHEPREFIX moves Python's cache tree, so a pyc there runs unseen; the PYTHON prefix covers it (fix brief 5, G12b).
    for (const name of ['NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PYTHONPATH', 'PYTHONPYCACHEPREFIX', 'PERL5OPT', 'RUBYOPT', 'BASH_ENV', 'Path', 'GEM_HOME', 'BUN_INSTALL']) expect(named({ FOO: '1', [name]: 'x' })).toBe(name)
    expect(named({ FOO: '1', CI: 'true', NODEJS_HOME: 'x' })).toBeUndefined()
    // The child reads a name up to its first `=` (fix brief 2, H4).
    for (const name of ['PATH=/w/bin:/usr/bin', 'ifs=x', 'BASH_ENV=./x']) expect(named({ [name]: 'x' })).toBe(name)
    expect(codeLoadingReason('NODE_OPTIONS')).toBe('the call sets NODE_OPTIONS, which changes what code runs; the decision AI does not rate it')
    expect(codeLoadingReason('LD_\u001b[2J')).toBe('the call sets "LD_\\u001b[2J", which changes what code runs; the decision AI does not rate it')
  })

  it('are shown to no stage: the call asks, and never takes the safe verdict kept for the plain command', async () => {
    const judge = fakeJudge()
    const runtime = await runtimeOf(node(), { judge })
    expect((await call(runtime)).ran).toBe(true)
    const { response, entry, ran } = await call(runtime, { env: { NODE_OPTIONS: '--require ./evil.js' } })
    expect(response).toMatchObject({ outcome: 'approval_required' })
    expect(ran).toBe(false)
    expect(judge.judge).toHaveBeenCalledTimes(1)
    expect(entry.judge).toMatchObject({ unavailable: 'the call sets NODE_OPTIONS, which changes what code runs; the decision AI does not rate it', passed: false })
    expect(JSON.stringify(entry)).not.toContain('evil')
    expect(JSON.stringify(response)).not.toContain('evil')
  })

  it('leave an allowed command to run as before under scope all, with nothing screened', async () => {
    const quickJudge: QuickJudge = { quick: vi.fn(async () => ({ kind: 'verdict' as const, level: 'danger' as const, confidence: 0.99, probabilities: { safe: 0, warning: 0.01, danger: 0.99 }, model: 'jev-1.13.0', latencyMs: 9 })) }
    const runtime = await runtimeOf(node({ BUCKLE_APPROVAL_QUICK_JUDGE: 'all' }), { quickJudge })
    await runtime.policy.apply({ ...emptyWorkspacePolicy(), commands: { allow: ['cat *'], deny: [] } })
    const { ran, entry } = await call(runtime, { env: { LD_PRELOAD: './evil.so' } }, ['cat', 'build.js'])
    expect(ran).toBe(true)
    expect(quickJudge.quick).not.toHaveBeenCalled()
    expect(entry.judge).toMatchObject({ quick: { unavailable: 'the call sets LD_PRELOAD, which changes what code runs; the decision AI does not rate it' }, passed: false, screened: true })
  })
})

describe('every other variable the call sets', () => {
  it('reaches the stage as the agent gave it, and gets a key of its own', async () => {
    const judge = fakeJudge()
    const runtime = await runtimeOf(node(), { judge })
    await call(runtime)
    expect(judge.shown[0]!.env).toEqual([])
    await call(runtime, { env: { FOO: '1' } })
    expect(judge.judge).toHaveBeenCalledTimes(2)
    expect(judge.shown[1]!.env).toEqual([{ name: 'FOO', value: '1' }])
    expect((await call(runtime, { env: { FOO: '1' } })).ran).toBe(true)
    expect(judge.judge).toHaveBeenCalledTimes(2)
    await call(runtime, { env: { FOO: '2' } })
    expect(judge.judge).toHaveBeenCalledTimes(3)
  })

  it('stays out of the audit entry and the approver\'s judge line', async () => {
    const judge = fakeJudge({ ...SAFE, level: 'danger', reasoning: 'It writes a file.' })
    const runtime = await runtimeOf(node(), { judge })
    const { response, entry } = await call(runtime, { env: { MARKER: 'env-value-7f3a' } })
    expect(response).toMatchObject({ outcome: 'approval_required' })
    expect(judge.shown[0]!.env).toEqual([{ name: 'MARKER', value: 'env-value-7f3a' }])
    expect(JSON.stringify(entry)).not.toContain('env-value-7f3a')
    expect(JSON.stringify(runtime.approvalService.listing()[0]!.call?.judge)).not.toContain('env-value-7f3a')
  })

  it('is sent with a secret\'s value hidden, and a credential in a URL hidden', () => {
    expect(shownVariables(callVariables({ env: { API_TOKEN: 'abc', DATABASE_URL: 'postgres://me:hunter2@db.example/app', MODE: 'fast' } }))).toEqual([
      { name: 'API_TOKEN', value: '[redacted]' },
      { name: 'DATABASE_URL', value: 'postgres://me:[redacted]@db.example/app' },
      { name: 'MODE', value: 'fast' },
    ])
  })
})

describe('the cache key', () => {
  const input = (overrides: Partial<JudgeInput> = {}): JudgeInput => ({
    command: 'node build.js', argv: ['node', 'build.js'], interpreters: ['node'], inline: null, env: [], files: [], packages: [], packagesTruncated: false, truncated: false,
    standardScript: false, policy: { allow: [], deny: [], destructive: [], allowedInterpreters: [] }, cwd: '/workspace', mounts: [], description: 'Run "node build.js"', reason: null, ...overrides,
  })
  const key = (asked: JudgeInput) => judgeCacheKey({ provider: 'openai-compatible', model: 'gpt-6-luna', policyUpdatedAt: null, asked })

  it('holds the variables, by name in any order, and the summary that names network access', () => {
    const base = key(input())
    expect(key(input({ env: [{ name: 'FOO', value: '1' }] }))).not.toBe(base)
    expect(key(input({ env: [{ name: 'A', value: '1' }, { name: 'B', value: '2' }] }))).toBe(key(input({ env: [{ name: 'B', value: '2' }, { name: 'A', value: '1' }] })))
    expect(key(input({ description: 'Run "node build.js", with network access' }))).not.toBe(base)
  })
})

describe('a call that changes its working directory before its code runs (fix brief 2, H2)', () => {
  it('is shown to no stage, and asks, wherever the change is written', async () => {
    const judge = fakeJudge()
    const runtime = await runtimeOf(node(), { judge })
    // dash, zsh, and tcsh take chdir as cd (fix brief 4, G10).
    const shellText = [['bash', '-c', 'cd sub && node build.js'], ['bash', '-c', 'pushd sub; node build.js'], ['sh', '-c', 'chdir sub && node build.js'], ['zsh', '-c', 'chdir sub && node build.js']]
    for (const command of [['env', '-C', 'sub', 'node', 'build.js'], ['env', '--chdir=sub', 'node', 'build.js'], ['bun', '--cwd', 'sub', 'run.ts'], ...shellText]) {
      // A shell wrapper needs an allow rule of its own before it may ask.
      if (command === shellText[0]) await runtime.policy.apply({ ...emptyWorkspacePolicy(), commands: { allow: ['bash -c *', 'sh -c *', 'zsh -c *', 'cd *', 'pushd *', 'chdir *'], deny: [] } })
      const { response, entry, ran } = await call(runtime, {}, command)
      expect(response, command.join(' ')).toMatchObject({ outcome: 'approval_required' })
      expect(ran).toBe(false)
      expect(entry.judge, command.join(' ')).toMatchObject({ unavailable: CHANGES_DIRECTORY, passed: false })
    }
    expect(judge.judge).not.toHaveBeenCalled()
    expect(CHANGES_DIRECTORY).toBe('the call changes its working directory before the code runs')
  })

  it('counts every builtin that changes the directory: cd, chdir, pushd, popd, and fish\'s prevd, nextd, and cdh (fix brief 4, G10)', () => {
    for (const builtin of ['cd sub', 'chdir sub', 'pushd sub', 'popd', 'prevd', 'nextd', 'cdh']) {
      expect(changesDirectory(commandFormsOf({ command: 'sh', args: ['-c', `${builtin} && python3 job.py`] })), builtin).toBe(true)
    }
    expect(changesDirectory(commandFormsOf({ command: 'sh', args: ['-c', 'python3 job.py'] }))).toBe(false)
  })

  it('reads sudo -D, which the quick stage rates under scope asks, and leaves an option of the command after env alone', async () => {
    const quickJudge: QuickJudge = { quick: vi.fn(async () => ({ kind: 'verdict' as const, level: 'safe' as const, confidence: 0.95, probabilities: { safe: 0.95, warning: 0.03, danger: 0.02 }, model: 'jev-1.13.0', latencyMs: 9 })) }
    const config = node({ BUCKLE_APPROVAL_QUICK_JUDGE: 'asks' })
    writeFileSync(join(config.cwd, 'job.py'), 'print(1)\n')
    const runtime = await runtimeOf(config, { quickJudge, judge: fakeJudge() })
    const sudo = await call(runtime, {}, ['sudo', '-D', 'sub', 'python3', 'job.py'])
    expect(sudo.response).toMatchObject({ outcome: 'approval_required' })
    expect(sudo.entry.judge).toMatchObject({ quick: { unavailable: CHANGES_DIRECTORY }, passed: false })
    expect(quickJudge.quick).not.toHaveBeenCalled()
    expect((await call(runtime, {}, ['env', 'node', '-C', 'development', 'build.js'])).ran).toBe(true)
  })

  it('leaves an allowed command to run as before under scope all, with nothing screened', async () => {
    const quickJudge: QuickJudge = { quick: vi.fn(async () => ({ kind: 'verdict' as const, level: 'danger' as const, confidence: 0.99, probabilities: { safe: 0, warning: 0.01, danger: 0.99 }, model: 'jev-1.13.0', latencyMs: 9 })) }
    const runtime = await runtimeOf(node({ BUCKLE_APPROVAL_QUICK_JUDGE: 'all' }), { quickJudge })
    await runtime.policy.apply({ ...emptyWorkspacePolicy(), commands: { allow: ['bash -c *', 'cd *', 'cat *'], deny: [] } })
    const { ran, entry } = await call(runtime, {}, ['bash', '-c', 'cd . && cat build.js'])
    expect(ran).toBe(true)
    expect(quickJudge.quick).not.toHaveBeenCalled()
    expect(entry.judge).toMatchObject({ quick: { unavailable: CHANGES_DIRECTORY }, screened: true })
  })
})

describe('a variable the call\'s own words or shell text set (fix brief 2, H3)', () => {
  const reason = (name: string) => `the call sets ${name}, which changes what code runs; the decision AI does not rate it`

  it('is checked as the env argument is: one that changes what code runs means no stage is asked, and the call asks', async () => {
    const judge = fakeJudge()
    const runtime = await runtimeOf(node(), { judge })
    const env = await call(runtime, {}, ['env', 'NODE_OPTIONS=--require ./evil.js', 'node', 'build.js'])
    expect(env.response).toMatchObject({ outcome: 'approval_required' })
    expect(env.entry.judge).toMatchObject({ unavailable: reason('NODE_OPTIONS'), passed: false })
    await runtime.policy.apply({ ...emptyWorkspacePolicy(), commands: { allow: ['bash -c *'], deny: [] } })
    for (const [text, name] of [['NODE_OPTIONS="--require ./evil.js" node build.js', 'NODE_OPTIONS'], ['export PYTHONPATH=/tmp/x; python3 job.py', 'PYTHONPATH'], ['declare -x LD_PRELOAD=./evil.so; node build.js', 'LD_PRELOAD']] as const) {
      const { response, entry, ran } = await call(runtime, {}, ['bash', '-c', text])
      expect(response, text).toMatchObject({ outcome: 'approval_required' })
      expect(ran).toBe(false)
      expect(entry.judge, text).toMatchObject({ unavailable: reason(name), passed: false })
      expect(JSON.stringify(entry.judge)).not.toContain('evil')
    }
    expect(judge.judge).not.toHaveBeenCalled()
  })

  it('reaches the stage beside the env argument where it changes no code, so the call is still rated', async () => {
    const judge = fakeJudge()
    const runtime = await runtimeOf(node(), { judge })
    expect((await call(runtime, { env: { MODE: 'fast' } }, ['env', 'FOO=1', 'node', 'build.js'])).ran).toBe(true)
    await runtime.policy.apply({ ...emptyWorkspacePolicy(), commands: { allow: ['bash -c *'], deny: [] } })
    expect((await call(runtime, {}, ['bash', '-c', 'FOO=1 node build.js'])).ran).toBe(true)
    expect(judge.shown.map(input => input.env)).toEqual([[{ name: 'FOO', value: '1' }, { name: 'MODE', value: 'fast' }], [{ name: 'FOO', value: '1' }]])
  })

  it('is read in each form a shell sets one: export, declare, typeset, a heredoc body, a slash in the value, setenv and set in C shell text', () => {
    const names = (command: string, args: string[]) => {
      const effect = { command, args }
      return assignedVariables(effect, commandFormsOf(effect)).variables.map(item => item.name.toUpperCase())
    }
    expect(names('bash', ['-c', 'typeset -x PERL5OPT=-Mevil; perl x.pl'])).toContain('PERL5OPT')
    expect(names('bash', ['-c', 'GCONV_PATH=/tmp/x/y node build.js'])).toContain('GCONV_PATH')
    expect(names('bash', ['-c', 'bash <<EOF\nRUBYOPT=-r./evil ruby x.rb\nEOF'])).toContain('RUBYOPT')
    expect(names('bash', ['-c', 'set -a; NODE_OPTIONS=--require=./evil.js; node build.js'])).toContain('NODE_OPTIONS')
    expect(names('tcsh', ['-c', 'setenv PATH /tmp/bin; node build.js'])).toContain('PATH')
    expect(names('csh', ['-c', 'set path=(/tmp/bin $path); node build.js'])).toContain('PATH')
    expect(names('sudo', ['LD_LIBRARY_PATH=/tmp', 'node', 'build.js'])).toContain('LD_LIBRARY_PATH')
    expect(names('env', ['node', 'build.js', 'PATH=x'])).toEqual([])
  })
})

describe('a call whose runtime loads variables from a file (fix brief 3, F2)', () => {
  const LOADS = 'the call loads variables from a file; the decision AI does not rate it'

  it('is shown to no stage, and asks, for node and bun in either spelling and inside shell text', async () => {
    const judge = fakeJudge()
    const config = node()
    writeFileSync(join(config.cwd, 'cfg.env'), 'MODE=fast\n')
    writeFileSync(join(config.cwd, 'run.ts'), 'console.log(1)\n')
    const runtime = await runtimeOf(config, { judge })
    const commands = [
      ['node', '--env-file=cfg.env', 'build.js'], ['node', '--env-file', 'cfg.env', 'build.js'], ['node', '--env-file-if-exists=cfg.env', 'build.js'],
      ['bun', '--env-file=cfg.env', 'run.ts'], ['bun', '--env-file', 'cfg.env', 'run.ts'], ['bun', 'run', '--env-file=cfg.env', 'run.ts'],
      ['bash', '-c', 'node --env-file=cfg.env build.js'],
    ]
    for (const command of commands) {
      // A shell wrapper needs an allow rule of its own before it may ask.
      if (command[0] === 'bash') await runtime.policy.apply({ ...emptyWorkspacePolicy(), commands: { allow: ['bash -c *'], deny: [] } })
      const { response, entry, ran } = await call(runtime, {}, command)
      expect(response, command.join(' ')).toMatchObject({ outcome: 'approval_required' })
      expect(ran).toBe(false)
      expect(entry.judge, command.join(' ')).toMatchObject({ unavailable: LOADS, passed: false })
    }
    expect(judge.judge).not.toHaveBeenCalled()
  })
})

describe('a long variable name in the reason (fix brief 3, F4)', () => {
  it('names only the part before any =, clipped, so a 90,000-character name gives a short reason and a bounded audit entry', async () => {
    expect(codeLoadingReason('LD_PRELOAD=/opt/lib.so')).toBe('the call sets LD_PRELOAD, which changes what code runs; the decision AI does not rate it')
    const name = `LD_PRELOAD${'A'.repeat(90_000)}`
    expect(codeLoadingReason(name)).toBe(`the call sets ${name.slice(0, 256)} [cut], which changes what code runs; the decision AI does not rate it`)
    const judge = fakeJudge()
    const config = node()
    writeFileSync(join(config.cwd, 'job.py'), 'print(1)\n')
    const runtime = await runtimeOf(config, { judge })
    await runtime.policy.apply({ ...emptyWorkspacePolicy(), commands: { allow: ['bash -c *'], deny: [] } })
    const { response, entry, ran } = await call(runtime, {}, ['bash', '-c', `export ${name}=1; python3 job.py`])
    expect(response).toMatchObject({ outcome: 'approval_required' })
    expect(ran).toBe(false)
    const reason = (entry.judge as { unavailable: string }).unavailable
    expect(reason.length).toBeLessThanOrEqual(500)
    expect(reason).toContain(' [cut]')
    expect(Buffer.byteLength(JSON.stringify(entry))).toBeLessThan(64 * 1_024)
    expect(judge.judge).not.toHaveBeenCalled()
  })
})

describe('a call that sets more variables than the stages are sent (fix brief 3, H3)', () => {
  /** One script_run bash call, through the real tool and the real permission pipeline; nothing runs. */
  async function script(runtime: BuckleRuntime, text: string) {
    const requestId = `script-${Math.random()}`
    const response = await runtime.invoke({ request: { requestId, approvalTokens: [], tool: 'script_run', args: { runtime: 'bash', script: text } }, sessionId: 'env', approvalWait: { mode: 'none' } })
    const entry = runtime.actions.read(200).find(item => item.event === 'result' && item.requestId === requestId)!
    return { response, entry }
  }

  const assignments = (count: number) => `${Array.from({ length: count }, (_, index) => `a${index}=${index}`).join('\n')}\nnode build.js`
  // The same assignments before the command on its one statement, which the reader rates whole (fix brief 4, P).
  const leading = (count: number) => `${Array.from({ length: count }, (_, index) => `a${index}=${index}`).join(' ')} node build.js`

  it('reads 50,000 unique assignments and refuses them within 200 ms, where the old dedupe was quadratic', () => {
    const effect = { command: 'bash', args: ['-c', assignments(50_000)] }
    // The command's forms are the permission pipeline's own reading, shared with every rule, so they are not the gate's cost.
    const forms = commandFormsOf(effect)
    const started = performance.now()
    const joined = joinedVariables([], assignedVariables(effect, forms).variables, MAX_SHOWN_VARIABLES)
    expect(performance.now() - started).toBeLessThan(200)
    expect(joined).toBeNull()
  })

  it('refuses a script_run call past 256 variables as truncated, and rates 200 with them in env', async () => {
    const judge = fakeJudge()
    const runtime = await runtimeOf(node(), { judge })
    await runtime.policy.apply({ ...emptyWorkspacePolicy(), commands: { allow: ['bash -c *'], deny: [] } })
    const many = await script(runtime, assignments(50_000))
    expect(many.response).toMatchObject({ outcome: 'approval_required' })
    expect(many.entry.judge).toMatchObject({ unavailable: 'the code closure exceeds what the judge reads', passed: false })
    expect(judge.judge).not.toHaveBeenCalled()
    const few = await script(runtime, leading(200))
    expect(few.entry.judge).toMatchObject({ passed: true, passedBy: 'thorough' })
    expect(judge.shown).toHaveLength(1)
    expect(judge.shown[0]!.env).toHaveLength(200)
  })
})

describe('shell text the reader does not rate whole (fix brief 4, P)', () => {
  it('is shown to no stage, and asks, while one simple command is rated as its direct form', async () => {
    const judge = fakeJudge()
    const config = node()
    writeFileSync(join(config.cwd, 'job.py'), 'print(1)\n')
    const runtime = await runtimeOf(config, { judge })
    await runtime.policy.apply({ ...emptyWorkspacePolicy(), commands: { allow: ['bash -c *'], deny: [] } })
    const compound = await call(runtime, {}, ['bash', '-c', 'python3 job.py && node build.js'])
    expect(compound.response).toMatchObject({ outcome: 'approval_required' })
    expect(compound.ran).toBe(false)
    expect(compound.entry.judge).toMatchObject({ unavailable: SHELL_TEXT_REFUSAL, passed: false })
    expect(judge.judge).not.toHaveBeenCalled()
    const simple = await call(runtime, {}, ['bash', '-c', 'node build.js 2>err.log'])
    expect(simple.ran).toBe(true)
    expect(judge.shown.map(input => input.files.map(file => file.path))).toEqual([['/workspace/build.js']])
  })

  it('rates a script_run bash body that is one command holding inline code, with the code shown (fix brief 5, P1)', async () => {
    const judge = fakeJudge()
    const runtime = await runtimeOf(node(), { judge })
    await runtime.policy.apply({ ...emptyWorkspacePolicy(), commands: { allow: ['bash -c *'], deny: [] } })
    const requestId = `script-${Math.random()}`
    await runtime.invoke({ request: { requestId, approvalTokens: [], tool: 'script_run', args: { runtime: 'bash', script: 'python3 -c "print(1)"' } }, sessionId: 'env', approvalWait: { mode: 'none' } })
    const entry = runtime.actions.read(200).find(item => item.event === 'result' && item.requestId === requestId)!
    expect(entry.judge).toMatchObject({ passed: true, passedBy: 'thorough' })
    expect(judge.shown.map(input => input.inline)).toEqual(['print(1)'])
  })
})

describe('the 500-character clip on a reason no stage rated (fix brief 4, G13)', () => {
  it('keeps a reason of 499 or 500 characters, cuts one of 501 to 500 ending in [cut], counts code points, and never cuts inside an escape', () => {
    expect(UNREAD_REASON_LIMIT).toBe(500)
    expect(clippedReason('a'.repeat(499))).toBe('a'.repeat(499))
    expect(clippedReason('a'.repeat(500))).toBe('a'.repeat(500))
    expect(clippedReason('a'.repeat(501))).toBe(`${'a'.repeat(494)} [cut]`)
    const astral = '\u{1F600}'
    expect(clippedReason(astral.repeat(300))).toBe(astral.repeat(300))
    expect(clippedReason(astral.repeat(501))).toBe(`${astral.repeat(494)} [cut]`)
    // A cut landing inside an escape drops the open escape; an escaped backslash before the cut is whole.
    expect(clippedReason(`${'x'.repeat(490)}\\u0001\\u0001`)).toBe(`${'x'.repeat(490)} [cut]`)
    expect(clippedReason(`${'x'.repeat(492)}\\\\${'y'.repeat(10)}`)).toBe(`${'x'.repeat(492)}\\\\ [cut]`)
  })

  it('bounds the reason on the audit entry and the approver listing at exactly 500 characters', async () => {
    const judge = fakeJudge()
    const config = node()
    writeFileSync(join(config.cwd, 'job.py'), 'print(1)\n')
    const runtime = await runtimeOf(config, { judge })
    // A control character escapes to six characters once the name is quoted, so only the clip bounds this reason.
    const name = `LD_${'A'.repeat(50)}${'\u0001'.repeat(203)}`
    const { response, entry } = await call(runtime, { env: { [name]: '1' } }, ['python3', 'job.py'])
    expect(response).toMatchObject({ outcome: 'approval_required' })
    const reason = (entry.judge as { unavailable: string }).unavailable
    expect(reason).toHaveLength(500)
    expect(reason.endsWith('\\u0001 [cut]')).toBe(true)
    expect(runtime.approvalService.listing()[0]!.call?.judge?.[0]).toMatchObject({ unavailable: reason })
    expect(judge.judge).not.toHaveBeenCalled()
  })
})

describe('a function bash imports from the environment (fix brief 4, P, extra)', () => {
  it('is a code-loading variable, set in the env argument or through env, since it runs in place of the command it names', async () => {
    const judge = fakeJudge()
    const config = node()
    writeFileSync(join(config.cwd, 'job.py'), 'print(1)\n')
    const runtime = await runtimeOf(config, { judge })
    await runtime.policy.apply({ ...emptyWorkspacePolicy(), commands: { allow: ['bash -c *', 'env *'], deny: [] } })
    const viaArgument = await call(runtime, { env: { 'BASH_FUNC_python3%%': '() { echo other; }' } }, ['bash', '-c', 'python3 job.py'])
    expect(viaArgument.ran).toBe(false)
    expect(viaArgument.entry.judge).toMatchObject({ unavailable: codeLoadingReason('BASH_FUNC_python3%%'), passed: false })
    const viaEnv = await call(runtime, {}, ['env', 'BASH_FUNC_python3%%=() { echo other; }', 'bash', '-c', 'python3 job.py'])
    expect(viaEnv.ran).toBe(false)
    expect(viaEnv.entry.judge).toMatchObject({ unavailable: codeLoadingReason('BASH_FUNC_python3%%'), passed: false })
    expect(judge.judge).not.toHaveBeenCalled()
  })
})

describe('a code-loading reason names the variable as typed (fix brief 5, D1)', () => {
  it('shows the typed case even where only a reduced form carried the assignment', async () => {
    const judge = fakeJudge()
    const runtime = await runtimeOf(node(), { judge })
    await runtime.policy.apply({ ...emptyWorkspacePolicy(), commands: { allow: ['bash -c *', 'nice *'], deny: [] } })
    for (const command of [['nice', 'PYTHONSTARTUP=x', 'python3', 'a.py'], ['bash', '-c', '{ PYTHONSTARTUP=x python3 a.py; }']]) {
      const { entry } = await call(runtime, {}, command)
      expect((entry.judge as { unavailable: string }).unavailable, command.join(' ')).toBe(codeLoadingReason('PYTHONSTARTUP'))
    }
    expect(judge.judge).not.toHaveBeenCalled()
  })
})

describe('a variable set after a leading redirection (fix brief 5, N2)', () => {
  it('is read, since the redirection no longer ends the statement before the assignment', async () => {
    const judge = fakeJudge()
    const runtime = await runtimeOf(node(), { judge })
    await runtime.policy.apply({ ...emptyWorkspacePolicy(), commands: { allow: ['bash -c *'], deny: [] } })
    const { response, entry, ran } = await call(runtime, {}, ['bash', '-c', '2>&1 PYTHONPATH=x python3 a.py'])
    expect(response).toMatchObject({ outcome: 'approval_required' })
    expect(ran).toBe(false)
    expect(entry.judge).toMatchObject({ unavailable: codeLoadingReason('PYTHONPATH'), passed: false })
    expect(judge.judge).not.toHaveBeenCalled()
  })
})

describe('a variable set after a leading &> redirection (fix brief 6, A1)', () => {
  it('is read, since the statement is cut at the & and the redirection is dropped', async () => {
    const judge = fakeJudge()
    const runtime = await runtimeOf(node(), { judge })
    await runtime.policy.apply({ ...emptyWorkspacePolicy(), commands: { allow: ['bash -c *'], deny: [] } })
    const { response, entry, ran } = await call(runtime, {}, ['bash', '-c', '&>x PYTHONPATH=x python3 a.py'])
    expect(response).toMatchObject({ outcome: 'approval_required' })
    expect(ran).toBe(false)
    expect(entry.judge).toMatchObject({ unavailable: codeLoadingReason('PYTHONPATH'), passed: false })
    expect(judge.judge).not.toHaveBeenCalled()
  })
})

describe('a variable set after a bare redirection operator (fix brief 6, A4)', () => {
  it('is read, since the gate shares the rules\' redirection grammar and the operator takes the next word as its target', async () => {
    const judge = fakeJudge()
    const runtime = await runtimeOf(node(), { judge })
    await runtime.policy.apply({ ...emptyWorkspacePolicy(), commands: { allow: ['bash -c *'], deny: [] } })
    for (const text of ['2>& 1 PYTHONPATH=x python3 a.py', '{fd}> out PYTHONPATH=x python3 a.py']) {
      const { response, entry, ran } = await call(runtime, {}, ['bash', '-c', text])
      expect(response, text).toMatchObject({ outcome: 'approval_required' })
      expect(ran, text).toBe(false)
      expect(entry.judge, text).toMatchObject({ unavailable: codeLoadingReason('PYTHONPATH'), passed: false })
    }
    expect(judge.judge).not.toHaveBeenCalled()
  })

  it('reads the shell text itself with that grammar, where no form of the rules carries the assignment', () => {
    // The forms of the shell call alone, its statements left out, so only the gate's own reading of the text finds it.
    const names = (text: string, shell = 'bash') => assignedVariables({ command: shell, args: ['-c', text] }, { ...commandForms(shell, ['-c', text]), nested: [] }).variables.map(variable => variable.name)
    expect(names('2>& 1 PYTHONPATH=x python3 a.py')).toContain('PYTHONPATH')
    expect(names('{fd}> out PYTHONPATH=x python3 a.py')).toContain('PYTHONPATH')
    // Both readings of a bare >!: zsh's, whose target is the next word, and bash's, whose target is `!`.
    expect(names('>! out PYTHONPATH=x python3 a.py', 'zsh')).toContain('PYTHONPATH')
    expect(names('>! PYTHONPATH=x python3 a.py')).toContain('PYTHONPATH')
  })
})

describe('a call that sets HOME (fix brief 5, P4)', () => {
  it('is not rated, since zsh and Python read startup code from HOME, and the reason names HOME with no value', async () => {
    expect(codeLoadingVariable(callVariables({ env: { HOME: '/workspace/h' } }))).toBe('HOME')
    const judge = fakeJudge()
    const config = node()
    writeFileSync(join(config.cwd, 'job.py'), 'print(1)\n')
    const runtime = await runtimeOf(config, { judge })
    const { response, entry, ran } = await call(runtime, { env: { HOME: '/workspace/h' } }, ['python3', 'job.py'])
    expect(response).toMatchObject({ outcome: 'approval_required' })
    expect(ran).toBe(false)
    expect(entry.judge).toMatchObject({ unavailable: codeLoadingReason('HOME'), passed: false })
    expect(JSON.stringify(entry.judge)).not.toContain('/workspace/h')
    expect(judge.judge).not.toHaveBeenCalled()
  })
})

describe('a call that sets SHELL (fix brief 5, P3)', () => {
  it('is not rated, since flock runs its -c text through $SHELL -c, and the reason names SHELL with no value', async () => {
    expect(codeLoadingVariable(callVariables({ env: { SHELL: '/workspace/other' } }))).toBe('SHELL')
    const judge = fakeJudge()
    const config = node()
    writeFileSync(join(config.cwd, 'job.py'), 'print(1)\n')
    const runtime = await runtimeOf(config, { judge })
    const { response, entry, ran } = await call(runtime, { env: { SHELL: '/workspace/other' } }, ['python3', 'job.py'])
    expect(response).toMatchObject({ outcome: 'approval_required' })
    expect(ran).toBe(false)
    expect(entry.judge).toMatchObject({ unavailable: codeLoadingReason('SHELL'), passed: false })
    expect(JSON.stringify(entry.judge)).not.toContain('/workspace/other')
    expect(judge.judge).not.toHaveBeenCalled()
  })
})
