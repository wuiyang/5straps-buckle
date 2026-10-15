import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyWorkspacePolicy } from '@5straps/protocol'
import { describe, expect, it, vi } from 'vitest'
import { runCli } from './support/cli.js'
import { compilePolicy, mergePolicies, PolicyError } from '../common/domain/policy.js'
import type { BuckleConfig } from '../common/runtime/config.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { registerWorkspace, workspacesOf } from './support/workspaces.js'

/**
 * The interpreter decision (docs/dev/architecture.md, Interpreters): a call that runs code with python, node, deno, bun,
 * perl, ruby, php, awk, lua, pwsh, tsx, or another listed interpreter is unknown to Buckle until the policy allows that
 * interpreter. These drive the CLI verbs and the real permission pipeline of a runtime.
 */
function node(environment: NodeJS.ProcessEnv = {}): BuckleConfig {
  return configFromEnvironment({
    BUCKLE_WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), 'buckle-interpreter-')),
    BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'buckle-interpreter-state-')),
    BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'true', BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_PACKS: 'fs,shell', BUCKLE_APPROVAL_TIMEOUT_MS: '1',
    ...environment,
  })
}

async function cli(config: BuckleConfig, argv: string[]) {
  let out = ''
  let err = ''
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { out += String(chunk); return true })
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { err += String(chunk); return true })
  try {
    return { ...(await runCli({ argv, config })), out, err }
  } finally { stdout.mockRestore(); stderr.mockRestore() }
}

/** A fresh runtime's permission pipeline, as the next process reads the policy; a prepared effect stands in, and nothing runs. */
async function call(config: BuckleConfig, command: string, args: string[]) {
  const runtime = await createRuntime({ config })
  const execute = vi.fn(async () => 'executed')
  const prepare = vi.spyOn(runtime.registry().get('shell_exec'), 'prepare').mockReturnValue({ effects: [{ kind: 'exec', command, args }], execute })
  try {
    return await runtime.invoke({ request: { requestId: `interpreter-${command}`, approvalTokens: [], tool: 'shell_exec', args: {} }, sessionId: 'interpreter', approvalWait: { mode: 'none' } })
  } finally { prepare.mockRestore() }
}

const unknown = (name: string) => `Runs code Buckle cannot read as shell, with an interpreter the policy does not allow (unknown interpreter): ${name} (allow it with buckle policy allow-interpreter ${name})`

describe('buckle policy allow-interpreter and remove-interpreter', () => {
  it('refuses an unknown interpreter under a deny glob until the workspace allows it, and again once it is removed', async () => {
    const config = node()
    expect((await cli(config, ['policy', 'deny-command', 'terraform destroy *'])).exitCode).toBe(0)
    expect(await call(config, 'node', ['script.js'])).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: expect.stringContaining(unknown('node')) } })

    const allowed = await cli(config, ['policy', 'allow-interpreter', 'node'])
    expect(allowed.exitCode).toBe(0)
    expect(allowed.out).toMatch(/Allowed interpreters[^\n]*\n\s+node\n/)
    expect(JSON.parse((await cli(config, ['policy', 'export'])).out).commands.allowedInterpreters).toEqual(['node'])
    expect(await call(config, 'node', ['script.js'])).toMatchObject({ outcome: 'ok' })
    expect(await call(config, 'python3', ['-c', 'print(1)'])).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED' } })

    expect((await cli(config, ['policy', 'remove-interpreter', 'node'])).exitCode).toBe(0)
    expect(JSON.parse((await cli(config, ['policy', 'export'])).out).commands.allowedInterpreters).toEqual([])
    expect(await call(config, 'node', ['script.js'])).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED' } })
  })

  it('asks at the floor about an unknown interpreter with no deny glob, and runs it as an ordinary command once allowed', async () => {
    const config = node()
    expect(await call(config, 'python3', ['-m', 'venv', '.venv'])).toMatchObject({ outcome: 'approval_required' })
    expect(await call(config, 'node', ['--version'])).toMatchObject({ outcome: 'ok' })
    await cli(config, ['policy', 'allow-interpreter', 'python3'])
    expect(await call(config, 'python3', ['-m', 'venv', '.venv'])).toMatchObject({ outcome: 'ok' })
  })

  it('shows an empty list by default and allows a name once', async () => {
    const config = node()
    expect((await cli(config, ['policy', 'show'])).out).toMatch(/Allowed interpreters[^\n]*\n\s+\(none\)/)
    await cli(config, ['policy', 'allow-interpreter', 'python3.12'])
    await cli(config, ['policy', 'allow-interpreter', 'python3.12'])
    expect(JSON.parse((await cli(config, ['policy', 'export'])).out).commands.allowedInterpreters).toEqual(['python3.12'])
  })

  it('allows awk, lua, pwsh, tsx, ts-node, and their kin by name', async () => {
    const config = node()
    const names = ['awk', 'gawk', 'mawk', 'nawk', 'lua', 'lua5.4', 'luajit', 'pwsh', 'powershell', 'tsx', 'ts-node']
    for (const name of names) expect((await cli(config, ['policy', 'allow-interpreter', name])).exitCode).toBe(0)
    expect(JSON.parse((await cli(config, ['policy', 'export'])).out).commands.allowedInterpreters).toEqual(names)
  })

  it.each([['bash'], ['python3 -c'], ['Node'], ['npx'], ['bunx']])('refuses %s, which is no interpreter Buckle knows, storing nothing', async (name) => {
    const config = node()
    const result = await cli(config, ['policy', 'allow-interpreter', name])
    expect(result.exitCode).toBe(1)
    expect(result.err).toContain('is not an interpreter Buckle reads as unknown')
    expect((await cli(config, ['policy', 'export'])).out).not.toContain('allowedInterpreters')
  })

  it('refuses an imported policy that allows a name no interpreter has', async () => {
    const config = node()
    const file = join(mkdtempSync(join(tmpdir(), 'buckle-interpreter-import-')), 'policy.json')
    writeFileSync(file, JSON.stringify({ version: 1, commands: { allow: [], deny: [], allowedInterpreters: ['bash'] } }))
    const result = await cli(config, ['policy', 'import', file])
    expect(result.exitCode).toBe(1)
    expect(result.err).toContain('Invalid interpreter "bash"')
  })

  it('names both verbs in the usage', async () => {
    const usage = (await cli(node(), ['policy', '--help'])).out
    expect(usage).toContain('buckle policy allow-interpreter <name>')
    expect(usage).toContain('buckle policy remove-interpreter <name>')
  })
})

describe('allowedInterpreters in a policy document', () => {
  it('is absent from an older document, which reads as none, and unions across the sources', () => {
    const older = emptyWorkspacePolicy()
    expect(compilePolicy(older).commands.allowedInterpreters).toEqual(new Set())
    const stored = emptyWorkspacePolicy()
    stored.commands.allowedInterpreters = ['node', 'python3']
    const other = emptyWorkspacePolicy()
    other.commands.allowedInterpreters = ['python3', 'perl']
    expect(mergePolicies(older, stored, other).commands.allowedInterpreters).toEqual(['node', 'python3', 'perl'])
    expect(mergePolicies(older, older).commands).not.toHaveProperty('allowedInterpreters')
  })

  it('refuses a name no interpreter has when it compiles', () => {
    const policy = emptyWorkspacePolicy()
    policy.commands.allowedInterpreters = ['python3', 'sh']
    expect(() => compilePolicy(policy)).toThrow(PolicyError)
  })
})

// Each workspace judges interpreters by its own list (docs/dev/architecture.md, Interpreters); no node list sits over a
// registered workspace's (Q14 of the workspace-model brief). BUCKLE_ALLOWED_INTERPRETERS is what a node set up before
// the workspace model allowed, which migration copies into its workspaces.
describe('a workspace\'s own interpreter allowance', () => {
  /** A registered workspace on a node whose environment is `environment`, its own policy denying `deny` and allowing `interpreters`. */
  async function registered(environment: NodeJS.ProcessEnv, child: { deny?: string[]; interpreters?: string[] } = {}): Promise<BuckleRuntime> {
    const root = mkdtempSync(join(tmpdir(), 'buckle-interpreter-own-'))
    mkdirSync(join(root, 'child'))
    const config = node(environment)
    const manager = await workspacesOf(config)
    const policy = emptyWorkspacePolicy()
    policy.commands.deny = child.deny ?? []
    if (child.interpreters) policy.commands.allowedInterpreters = child.interpreters
    await registerWorkspace(manager, { id: 'child', name: 'Child', dir: join(root, 'child'), policy })
    return (await manager.resolve('child')).runtime
  }

  /** The registered workspace's real permission pipeline on `node script.js`; a prepared effect stands in, and nothing runs. */
  async function nodeScript(runtime: BuckleRuntime) {
    const execute = vi.fn(async () => 'executed')
    const prepare = vi.spyOn(runtime.registry().get('fs_read'), 'prepare').mockReturnValue({ effects: [{ kind: 'exec', command: 'node', args: ['script.js'] }], execute })
    try {
      return await runtime.invoke({ request: { requestId: `interpreter-${randomUUID()}`, approvalTokens: [], tool: 'fs_read', args: { path: '/workspace/file.txt' } }, sessionId: 'interpreter', approvalWait: { mode: 'none' } })
    } finally { prepare.mockRestore() }
  }

  const refused = { outcome: 'error', error: { code: 'PERMISSION_DENIED', message: `${unknown('node')}, so the workspace command policy's deny list cannot meet all of it; refused rather than asked` } }

  it('reads node script.js as an ordinary command when the workspace allows node, whatever the node\'s environment names', async () => {
    expect(await nodeScript(await registered({ BUCKLE_COMMAND_DENY: 'terraform destroy *' }, { interpreters: ['node'] }))).toMatchObject({ outcome: 'ok' })
    expect(await nodeScript(await registered({}, { deny: ['terraform destroy *'], interpreters: ['node'] }))).toMatchObject({ outcome: 'ok' })
  })

  it('reads node as unknown when the workspace does not allow it, whatever the node\'s environment names', async () => {
    const environment = { BUCKLE_COMMAND_DENY: 'terraform destroy *', BUCKLE_ALLOWED_INTERPRETERS: 'node' }
    expect(await nodeScript(await registered(environment))).toMatchObject({ outcome: 'approval_required' })
    expect(await nodeScript(await registered(environment, { deny: ['terraform destroy *'] }))).toMatchObject(refused)
  })

  it('allows the interpreters a node\'s environment named in its own folder, workspace default, once migrated', async () => {
    const config = node({ BUCKLE_COMMAND_DENY: 'terraform destroy *', BUCKLE_ALLOWED_INTERPRETERS: 'node' })
    expect(await call(config, 'node', ['script.js'])).toMatchObject({ outcome: 'ok' })
    expect(await call(config, 'python3', ['-c', 'print(1)'])).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: expect.stringContaining(unknown('python3')) } })
    expect((await cli(config, ['policy', 'show'])).out).toMatch(/Allowed interpreters[^\n]*\n\s+node\n/)
  })

  it.each(['bash', 'python3,sh', 'Node'])('refuses to load with %s, naming the variable', (value) => {
    expect(() => node({ BUCKLE_ALLOWED_INTERPRETERS: value })).toThrow(/^Invalid BUCKLE_ALLOWED_INTERPRETERS: \S+ is not an interpreter Buckle reads as unknown: python, pypy, node/)
  })
})
