import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyWorkspacePolicy } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { commandSubject } from '../common/domain/argv.js'
import { compilePolicy } from '../common/domain/policy.js'
import type { ResolvedEffect } from '../common/domain/effect.js'
import type { PermissionDecision } from '../common/domain/permission/decision.js'
import { createPermissionEngine } from '../common/domain/permission/engine.js'
import { judgeable, quickCovers } from '../common/domain/permission/judged.js'
import { createCommandPolicyRule } from '../common/domain/permission/rules/command-policy-rule.js'
import { withDangerouslyAllow } from '../common/domain/permission/rules/dangerously-allow.js'
import { createDestructiveCommandRule, SCRIPT_FILE_REASON } from '../common/domain/permission/rules/destructive-command-rule.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import type { DangerouslyAllowMode } from '../common/types/ports/dangerously-allow-store.js'
import { settleAuditLogs } from './support/action-log-writer.js'
import { configFromEnvironment } from './support/workspace-config.js'

// A script file run directly: a shell or `source` given a script file, or a command word written as a path,
// runs code Buckle does not read, so it asks as unread code does. A package script (`npm run`) and a task runner keep
// their own words.

type Ask = Extract<PermissionDecision, { kind: 'ask' }>

const NO_GRANTS = { subjectsFor: () => [] }

function engineOf(commands: { allow?: string[]; deny?: string[] } = {}) {
  const policy = emptyWorkspacePolicy()
  policy.commands.allow = commands.allow ?? []
  policy.commands.deny = commands.deny ?? []
  const compiled = compilePolicy(policy)
  // The allow rule a shell wrapper needs is left out: these judge what a shell body runs, not the wrapper.
  return createPermissionEngine([
    createCommandPolicyRule(compiled, { enforceWrapperAllow: false }),
    createDestructiveCommandRule({ added: compiled.commands.destructive, allow: compiled.commands.allow }),
  ])
}

function evaluate(command: string, args: string[], commands: { allow?: string[]; deny?: string[] } = {}, shownAs?: string) {
  const effect: ResolvedEffect = { kind: 'exec', command, args, ...(shownAs === undefined ? {} : { shownAs }) }
  return engineOf(commands).evaluate({ tool: 'shell_exec', effects: [effect], grants: NO_GRANTS })
}

function askOf(command: string, args: string[]): Ask {
  const outcome = evaluate(command, args)
  if (outcome.kind !== 'ask' || outcome.asks.length !== 1) throw new Error(`${command} ${args.join(' ')} did not ask once: ${JSON.stringify(outcome)}`)
  return outcome.asks[0]!
}

const RUNS: Array<[string, string, string[]]> = [
  ['sh with a script', 'sh', ['x.sh']],
  ['bash with a script', 'bash', ['deploy.sh', '--prod']],
  ['bash with options before its script', 'bash', ['-e', '-o', 'pipefail', 'deploy.sh']],
  ['zsh with a script', 'zsh', ['x.sh']],
  ['dash with a script', 'dash', ['x.sh']],
  ['a script by its relative path', './x.sh', []],
  ['a program in a folder of the workspace', 'bin/tool', ['--flag']],
  ['a script by its absolute path', '/tmp/x.sh', []],
  ['a script behind a wrapper', 'env', ['FOO=1', './x.sh']],
  ['a script xargs runs', 'xargs', ['./x.sh']],
  ['a script a shell body runs by its path', 'bash', ['-c', 'cd app && ./build.sh']],
  ['a script a shell body sources', 'bash', ['-c', 'source ./env.sh && make']],
  ['a script a shell body dots', 'bash', ['-c', '. venv/bin/activate']],
  ['a script a shell body hands bash', 'bash', ['-c', 'bash ./run.sh']],
  ['a script find runs', 'find', ['.', '-name', '*.txt', '-exec', './x.sh', '{}', ';']],
  ['a script a substitution cuts', 'bash', ['-c', './deploy.sh "$(date)"']],
  ['a script after a substitution', 'bash', ['-c', 'v=$(date) ./deploy.sh']],
]

const ORDINARY: Array<[string, string, string[]]> = [
  ['npm run', 'npm', ['run', 'build']],
  ['npm test', 'npm', ['test']],
  ['pnpm with a script name', 'pnpm', ['dev']],
  ['yarn run', 'yarn', ['run', 'lint']],
  ['make', 'make', ['test']],
  ['a bare program', 'git', ['status']],
  ['a shell body of bare programs', 'bash', ['-c', 'git status && ls']],
  ['a script name as an argument', 'cat', ['x.sh']],
  ['a script name inside a quoted word', 'git', ['commit', '-m', 'run ./x.sh; then . env.sh']],
  ['a shell version call', 'bash', ['--version']],
  ['a heredoc body no shell runs', 'bash', ['-c', 'cat <<EOF\n./x.sh\nEOF']],
  ['the words after a shell\'s -c text', 'bash', ['-c', 'echo "$0"', './x.sh']],
]

describe('a script file run directly asks', () => {
  it.each(RUNS)('%s: %s %j asks at the destructive floor as unread code', (_, command, args) => {
    expect(askOf(command, args)).toMatchObject({
      rule: 'destructive_command', subject: expect.any(String), reason: SCRIPT_FILE_REASON,
      cause: 'script', floor: false, destructive: true, offeredScopes: ['once', 'session'], severity: 'warn',
    })
  })

  it.each(ORDINARY)('%s: %s %j keeps its own words, with no script ask', (_, command, args) => {
    expect(evaluate(command, args)).toMatchObject({ kind: 'allow' })
  })

  it('leaves alone a host path Buckle supplies itself', () => {
    expect(evaluate('/opt/tools/varlock', ['load', '--agent'], {}, 'varlock')).toMatchObject({ kind: 'allow' })
  })

  it('asks under a deny list rather than refusing, since the deny list never read the script either way', () => {
    expect(evaluate('./deploy.sh', [], { deny: ['git push *'] })).toMatchObject({ kind: 'ask', asks: [{ cause: 'script', reason: SCRIPT_FILE_REASON }] })
    expect(evaluate('bash', ['deploy.sh'], { deny: ['git push *'] })).toMatchObject({ kind: 'ask', asks: [{ cause: 'script' }] })
  })

  it('runs a program by its path where an allow glob spells that path (D74), and asks for a shell\'s script whatever the allow list says', () => {
    expect(evaluate('./deploy.sh', ['--prod'], { allow: ['./deploy.sh *'] })).toMatchObject({ kind: 'allow' })
    expect(evaluate('bash', ['-c', './deploy.sh'], { allow: ['bash -c *', './deploy.sh'] })).toMatchObject({ kind: 'allow' })
    expect(evaluate('./other.sh', [], { allow: ['./deploy.sh', 'other.sh'] })).toMatchObject({ kind: 'ask', asks: [{ cause: 'floor' }] })
    expect(evaluate('bash', ['deploy.sh'], { allow: ['bash deploy.sh'] })).toMatchObject({ kind: 'ask', asks: [{ cause: 'script' }] })
    expect(evaluate('bash', ['-c', 'source ./env.sh'], { allow: ['bash -c *', './env.sh', 'source *'] })).toMatchObject({ kind: 'ask', asks: [{ cause: 'script' }] })
  })

  it('names the stricter reason where the call meets another: the floor, then an unknown interpreter', () => {
    expect(askOf('sudo', ['./x.sh'])).toMatchObject({ cause: 'floor', floor: true })
    expect(askOf('bash', ['-c', 'rm -rf build; ./x.sh'])).toMatchObject({ cause: 'floor' })
    expect(askOf('bash', ['-c', 'python3 job.py && ./x.sh'])).toMatchObject({ cause: 'interpreter' })
  })

  it('takes a granted subject as answered, as every floor ask does', () => {
    const rule = createDestructiveCommandRule()
    const effect: ResolvedEffect = { kind: 'exec', command: './x.sh', args: [] }
    const subject = commandSubject('./x.sh', [])
    expect(rule.evaluate({ tool: 'shell_exec', effect, grants: { subjectsFor: () => [subject] } })).toMatchObject({ kind: 'allow', via: { rule: 'destructive_command', subject } })
  })
})

describe('who may answer a script file ask', () => {
  function underSwitch(mode: DangerouslyAllowMode, command: string, args: string[]) {
    const engine = withDangerouslyAllow(engineOf(), { mode: () => mode, root: () => '/w' })
    return engine.evaluate({ tool: 'shell_exec', effects: [{ kind: 'exec', command, args }], grants: NO_GRANTS })
  }

  it.each(RUNS)('%s: %s %j asks while the switch is off and safe, and runs while on', (_, command, args) => {
    expect(underSwitch('off', command, args)).toMatchObject({ kind: 'ask', asks: [{ cause: 'script' }] })
    expect(underSwitch('safe', command, args)).toMatchObject({ kind: 'ask', asks: [{ cause: 'script' }] })
    expect(underSwitch('on', command, args)).toMatchObject({ kind: 'allow', allowedBy: [expect.stringMatching(/^dangerously_allow:on:destructive_command:/)] })
  })

  it('is one the decision AI may answer, as an unknown interpreter\'s is, and its quick stage rates under each scope but off', () => {
    const script = askOf('./deploy.sh', [])
    expect(judgeable(script)).toBe(true)
    expect(quickCovers('interpreters', script)).toBe(true)
    expect(quickCovers('asks', script)).toBe(true)
    expect(quickCovers('off', script)).toBe(false)
  })
})

describe('a program named by its path, as the node judges it', () => {
  const roots: string[] = []
  const runtimes: CoreRuntime[] = []
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) { runtime.closeWatchers(); await runtime.approvalService.close(); await runtime.history.close() }
    await settleAuditLogs()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  async function node() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-script-path-')))
    roots.push(root)
    const workspace = join(root, 'workspace')
    for (const folder of [join(workspace, 'bin'), join(root, 'state')]) mkdirSync(folder, { recursive: true, mode: 0o700 })
    writeFileSync(join(workspace, 'bin', 'tool'), '#!/bin/sh\n', { mode: 0o700 })
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'true', BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_PACKS: 'fs,shell', BUCKLE_APPROVAL_TIMEOUT_MS: '1' })
    const runtime = await createRuntime({ config })
    runtimes.push(runtime)
    const run = async (command: string, args: string[]) => {
      const prepare = vi.spyOn(runtime.registry().get('shell_exec'), 'prepare').mockReturnValue({ effects: [{ kind: 'exec', command, args }], execute: vi.fn(async () => 'executed') })
      try {
        return await runtime.invoke({ request: { requestId: `path-${command}`, approvalTokens: [], tool: 'shell_exec', args: {} }, sessionId: 'path', approvalWait: { mode: 'none' } })
      } finally { prepare.mockRestore() }
    }
    return { workspace, run }
  }

  it.each<[string, string, string[]]>([
    ['a system program', '/usr/bin/env', ['true']],
    ['a system program behind a wrapper', 'env', ['/usr/bin/env', 'true']],
    ['a system program a link may name', '/bin/sh', ['--version']],
  ])('runs %s, which the agent cannot have placed, with no script ask: %s %j', async (_, command, args) => {
    const { run } = await node()
    const response = await run(command, args)
    expect(response.outcome, JSON.stringify(response)).toBe('ok')
  })

  it.each<[string, string, string[]]>([
    ['a file the agent may write outside the workspace', '/tmp/x.sh', []],
    ['a program outside the system folders', '/opt/notbuckle', ['approve', 'abc']],
    ['a wrapper by its relative path', './gradlew', ['build']],
    ['a package\'s own program', './node_modules/.bin/vitest', ['run']],
    ['a program through a dot segment', '/usr/bin/../../tmp/x.sh', []],
  ])('asks about %s: %s %j', async (_, command, args) => {
    const { run } = await node()
    expect(await run(command, args)).toMatchObject({ outcome: 'approval_required', approvals: [{ rule: 'destructive_command' }] })
  })

  it('asks about a program in the workspace named by its absolute path', async () => {
    const { workspace, run } = await node()
    expect(await run(join(workspace, 'bin', 'tool'), [])).toMatchObject({ outcome: 'approval_required', approvals: [{ rule: 'destructive_command' }] })
  })
})
