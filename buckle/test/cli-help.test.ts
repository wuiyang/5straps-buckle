import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyWorkspacePolicy } from '@5straps/protocol'
import { answerWithoutConfiguration } from '../cli/main.js'
import { runCli } from './support/cli.js'
import { policyCommand, repairStoredPolicy } from '../cli/policy.js'
import { StoredPolicyError } from '../common/domain/policy.js'
import { configFromEnvironment } from './support/workspace-config.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { settingsPath, withPolicy } from '../common/services/workspaces/workspace-settings.js'
import { workspacesOf } from './support/workspaces.js'

// The top-level help once omitted the dangerously-allow switch and `buckle client approve`, and `buckle policy --help`
// printed its usage but exited 1, so a wrapper that treats a non-zero exit as failure saw asking for help as an error
// (public docs review).

afterEach(() => vi.restoreAllMocks())

/** What both helps say of the switch's two levels. */
const LEVELS_SAID = "each use is audited and deny rules still refuse. At level command, the default, a secret reference's file still asks a person; at level all it is allowed too"

const captured = () => {
  let out = ''
  let err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { out += String(chunk); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { err += String(chunk); return true })
  return { out: () => out, err: () => err }
}

/** A node in fresh directories whose workspace default's policy denies `curl *`, with its settings file's text before any command. */
async function storedNode(prefix: string) {
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), `${prefix}-`)), BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), `${prefix}-state-`)), BUCKLE_SANDBOX: 'none' })
  const stored = { ...emptyWorkspacePolicy(), commands: { ...emptyWorkspacePolicy().commands, deny: ['curl *'] } }
  const workspaces = await workspacesOf(config)
  await workspaces.updateSettings(config.workspaceId, current => withPolicy(current, stored))
  const file = settingsPath(config.nodeStateDirectory!, config.workspaceId)
  return { config, stored, workspaces, file, before: readFileSync(file, 'utf8') }
}

describe('buckle --help', () => {
  it('lists the dangerously-allow switch under policy, with its warning, and exits 0', () => {
    const io = captured()
    const result = answerWithoutConfiguration(['--help'])
    expect(result).toEqual({ exitCode: 0 })
    expect(io.out()).toContain('buckle policy dangerously-allow on [command|all] | off')
    expect(io.out()).toContain('DANGEROUS')
    // At level command, the bare on, the switch never answers a secret reference's ask (docs/user/how-to/secrets.md), so its help
    // says so (review of 6de734c); at level all it does (owner ruling of 2026-10-25).
    expect(io.out().replace(/\s+/g, ' ')).toContain(LEVELS_SAID)
  })

  it('names buckle client approve on the client line, as the settings reference and the approvals page do', () => {
    const io = captured()
    answerWithoutConfiguration(['--help'])
    expect(io.out()).toMatch(/^ {2}buckle client .*\| approve <node-url> <token>$/m)
  })

  // Buckle's public surface discusses Buckle only, and init no longer pairs the node with a control plane (owner ruling of 2026-11-03).
  it('names no other product and no pairing option', () => {
    const io = captured()
    answerWithoutConfiguration(['--help'])
    expect(io.out()).toContain('buckle init')
    expect(io.out()).not.toMatch(/\bRings\b|--pair|--rings/i)
  })
})

describe('buckle policy --help', () => {
  // The help case returns before any runtime or workspace is touched, so neither is built for this call.
  const runtime = {} as unknown as BuckleRuntime

  it.each(['--help', '-h', 'help'])('prints the usage to stdout and exits 0 for %s', async (flag) => {
    const io = captured()
    const result = await policyCommand(runtime, [flag])
    expect(result.exitCode).toBe(0)
    expect(io.out()).toContain('buckle policy dangerously-allow on [command|all] | off')
    expect(io.out().replace(/\s+/g, ' ')).toContain(LEVELS_SAID)
    expect(io.err()).toBe('')
  })

  it('still exits 1 and prints the usage to stderr for an unknown subcommand', async () => {
    const io = captured()
    const result = await policyCommand(runtime, ['not-a-subcommand'])
    expect(result.exitCode).toBe(1)
    expect(io.err()).toContain('buckle policy show')
    expect(io.out()).toBe('')
  })
})

// `buckle policy allow-command 'git *' --workspace child` edited the node's own workspace and exited 0, as if it had
// changed the workspace the flag names. The CLI takes --workspace and --dir before the command sees them (D83 (4)); an
// edit refuses any flag it does not know before it touches any policy: the runtime here is empty, so any reading or
// writing of a policy would throw.
describe('buckle policy refuses a flag it does not know', () => {
  const runtime = {} as unknown as BuckleRuntime

  it.each([
    [['allow-command', 'git push *', '--workspace', 'child'], '--workspace'],
    [['deny-command', '--workspace=child', 'curl *'], '--workspace=child'],
    [['allow-interpreter', 'node', '-w', 'child'], '-w'],
    [['allow-url', 'example.com', '--force'], '--force'],
    [['clear', '--workspace', 'child'], '--workspace'],
    [['export', '--json'], '--json'],
  ])('refuses %j with the usage and exit 1, naming %s', async (argv, flag) => {
    const io = captured()
    const result = await policyCommand(runtime, argv)
    expect(result.exitCode).toBe(1)
    expect(io.err()).toContain(`buckle policy ${argv[0]} does not know the flag ${flag}\n`)
    expect(io.err()).toContain('buckle policy show')
    expect(io.out()).toBe('')
  })

  // `show` and `dangerously-allow` parse flags of their own, and an unknown one left the option parser's own error.
  it.each([
    [['show', '--bogus'], '--bogus'],
    [['dangerously-allow', '--bogus'], '--bogus'],
  ])('refuses %j, an action with flags of its own, with the usage and exit 1, naming %s', async (argv, flag) => {
    const io = captured()
    const result = await policyCommand(runtime, argv)
    expect(result.exitCode).toBe(1)
    expect(io.err()).toContain(`buckle policy ${argv[0]} does not know the flag ${flag}\n`)
    expect(io.err()).toContain('buckle policy show')
    expect(io.out()).toBe('')
  })

  it('refuses one while repairing a stored policy the node cannot load, and leaves the stored file as it was', async () => {
    const { config, stored, workspaces, file, before } = await storedNode('buckle-flag')
    const failure = new StoredPolicyError({ file, reason: 'a test failure', stored })
    const io = captured()
    const result = await repairStoredPolicy({ workspaces, target: {}, cwd: config.cwd, argv: ['clear', '--force'], failure })
    expect(result.exitCode).toBe(1)
    expect(io.err()).toContain('buckle policy clear does not know the flag --force')
    expect(readFileSync(file, 'utf8')).toBe(before)
  })
})

// `buckle policy deny-command git push*` typed without quotes stored the glob `git`, dropped the rest, and exited 0,
// so the owner believed a rule existed that did not. An action that takes one argument refuses more, showing the
// quoted form, before it touches any policy: the runtime here is empty, so any reading or writing would throw.
describe('buckle policy refuses words past its one argument', () => {
  const runtime = {} as unknown as BuckleRuntime

  it.each([
    [['allow-command', 'pnpm', 'test', '*'], `'pnpm test *'`],
    [['deny-command', 'git', 'push*'], `'git push*'`],
    [['destructive-command', 'terraform', 'destroy', '*'], `'terraform destroy *'`],
    [['allow-interpreter', 'python3', 'node'], `'python3 node'`],
    [['remove-interpreter', 'python3', 'node'], `'python3 node'`],
    [['allow-url', 'example.com', 'docs.test'], `'example.com docs.test'`],
    [['mount', '/my', 'workspace'], `'/my workspace'`],
    [['deny-tool', 'fs_write', 'shell_exec'], `'fs_write shell_exec'`],
    [['allow-tool', 'fs_write', 'shell_exec'], `'fs_write shell_exec'`],
    [['remove', 'git', 'push*'], `'git push*'`],
    [['import', 'a.json', 'b.json'], `'a.json b.json'`],
    [['allow-command', 'echo', 'it\'s'], `'echo it'\\''s'`],
  ])('refuses %j with the usage and exit 1, quoting it as %s', async (argv, quoted) => {
    const io = captured()
    const result = await policyCommand(runtime, argv)
    expect(result.exitCode).toBe(1)
    expect(io.err()).toContain(`buckle policy ${argv[0]} takes one argument, not ${argv.length - 1}; to pass a glob or path of several words, quote it as one: buckle policy ${argv[0]} ${quoted}\n`)
    expect(io.err()).toContain('buckle policy show')
    expect(io.out()).toBe('')
  })

  it('stores nothing through the whole command, and the stored file stays as it was', async () => {
    const { config, file, before } = await storedNode('buckle-words')
    const io = captured()
    const result = await runCli({ argv: ['policy', 'deny-command', 'git', 'push*'], config })
    expect(result.exitCode).toBe(1)
    expect(io.err()).toContain('quote it as one: buckle policy deny-command \'git push*\'')
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('refuses them while repairing a stored policy the node cannot load, and leaves the stored file as it was', async () => {
    const { config, stored, workspaces, file, before } = await storedNode('buckle-words')
    const failure = new StoredPolicyError({ file, reason: 'a test failure', stored })
    const io = captured()
    const result = await repairStoredPolicy({ workspaces, target: {}, cwd: config.cwd, argv: ['remove', 'curl', '*'], failure })
    expect(result.exitCode).toBe(1)
    expect(io.err()).toContain('quote it as one: buckle policy remove \'curl *\'')
    expect(readFileSync(file, 'utf8')).toBe(before)
  })
})
