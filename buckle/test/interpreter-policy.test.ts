import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyWorkspacePolicy } from '@5straps/protocol'
import { describe, expect, it, vi } from 'vitest'
import { runCli } from '../cli/main.js'
import { compilePolicy, mergePolicies, PolicyError } from '../common/domain/policy.js'
import { loadConfig, type BuckleConfig } from '../common/runtime/config.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'

/**
 * Owner decision D55: a call that runs code with python, node, deno, bun, perl, ruby or php is unknown to Buckle until
 * the policy allows that interpreter. These drive the CLI verbs and the real permission pipeline of a runtime.
 */
function node(): BuckleConfig {
  return loadConfig({
    BUCKLE_WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), 'buckle-interpreter-')),
    BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'buckle-interpreter-state-')),
    BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'true', BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_PACKS: 'fs,shell', BUCKLE_APPROVAL_TIMEOUT_MS: '1',
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

const unknown = (name: string) => `Runs code Buckle cannot read as shell, with an interpreter the policy does not allow (unknown interpreter): ${name}`

describe('buckle policy allow-interpreter and remove-interpreter', () => {
  it('refuses an unknown interpreter under a deny glob until the workspace allows it, and again once it is removed', async () => {
    const config = node()
    expect((await cli(config, ['policy', 'deny-command', 'terraform destroy *'])).exitCode).toBe(0)
    expect(await call(config, 'node', ['script.js'])).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: expect.stringContaining(unknown('node')) } })

    const allowed = await cli(config, ['policy', 'allow-interpreter', 'node'])
    expect(allowed.exitCode).toBe(0)
    expect(allowed.out).toMatch(/Allowed interpreters[^\n]*\n\s+node\s+stored/)
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

  it.each([['bash'], ['python3 -c'], ['Node']])('refuses %s, which is no interpreter Buckle knows, storing nothing', async (name) => {
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
