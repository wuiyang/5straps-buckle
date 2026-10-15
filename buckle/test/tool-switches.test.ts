import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { BuckleConfig } from '../common/runtime/config.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { runCli } from './support/cli.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'

function node(): BuckleConfig {
  const root = mkdtempSync(join(tmpdir(), 'buckle-tool-switch-'))
  writeFileSync(join(root, 'notes.txt'), 'hello\n')
  return configFromEnvironment({
    BUCKLE_WORKSPACE_ROOT: root,
    BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'buckle-tool-switch-state-')),
    BUCKLE_ALLOW_SHELL: 'false',
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

/** A fresh runtime per call, as a restarted node or the next CLI process would read the policy file. */
async function invoke(config: BuckleConfig, tool: string, args: Record<string, unknown>) {
  const runtime = await createRuntime({ config })
  const response = await runtime.invoke({ request: { requestId: `r-${tool}`, tool, args: args as Record<string, never>, approvalTokens: [] }, sessionId: 'tool-switch' })
  return { response, pending: runtime.approvals.pending(), listed: runtime.manifest().tools.map(capability => capability.name) }
}

describe('buckle policy deny-tool and allow-tool', () => {
  it('refuses a denied tool with the reason, even where its pack is on', async () => {
    const config = node()
    expect((await cli(config, ['policy', 'deny-tool', 'fs_read'])).exitCode).toBe(0)

    const { response, listed } = await invoke(config, 'fs_read', { path: 'notes.txt' })

    expect(response).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: 'Disabled by workspace tool policy' } })
    expect(listed).not.toContain('fs_read')
    expect(listed).toContain('fs_write')
  })

  it('refuses before any approval is asked, so a call that would prompt is not prompted', async () => {
    const config = node()
    const outside = mkdtempSync(join(tmpdir(), 'buckle-tool-switch-outside-'))
    writeFileSync(join(outside, 'secret.txt'), 'x\n')
    expect((await invoke(config, 'fs_read', { path: join(outside, 'secret.txt') })).response.outcome).toBe('approval_required')

    await cli(config, ['policy', 'deny-tool', 'fs_read'])
    const runtime = await createRuntime({ config })
    const waiting = runtime.approvals.pending().length
    const response = await runtime.invoke({ request: { requestId: 'r-denied', tool: 'fs_read', args: { path: join(outside, 'secret.txt') }, approvalTokens: [] }, sessionId: 'tool-switch' })

    expect(response).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED' } })
    expect(runtime.approvals.pending()).toHaveLength(waiting)
  })

  it('restores the tool with allow-tool', async () => {
    const config = node()
    await cli(config, ['policy', 'deny-tool', 'fs_read'])
    expect((await cli(config, ['policy', 'allow-tool', 'fs_read'])).exitCode).toBe(0)

    const { response, listed } = await invoke(config, 'fs_read', { path: 'notes.txt' })

    expect(response.outcome).toBe('ok')
    expect(listed).toContain('fs_read')
  })

  it('lists denied tools in policy show', async () => {
    const config = node()
    await cli(config, ['policy', 'deny-tool', 'web_fetch'])

    const shown = await cli(config, ['policy', 'show'])

    expect(shown.out).toMatch(/Denied tools[^\n]*\n\s+web_fetch  the workspace's own\n/)
  })

  it('leaves a tool in a withheld pack unavailable whatever allow-tool says, and says why', async () => {
    const config = node()
    await cli(config, ['policy', 'deny-tool', 'git_status'])
    const allowed = await cli(config, ['policy', 'allow-tool', 'git_status'])

    expect(allowed.out).toContain('git_status stays unavailable: its pack git is withheld')
    expect(allowed.out).toContain('packs.hostGit')
    const { response, listed } = await invoke(config, 'git_status', {})
    expect(response.outcome).toBe('error')
    expect(listed).not.toContain('git_status')
  })

  it('refuses a name that is not a tool name, storing nothing', async () => {
    const config = node()

    const result = await cli(config, ['policy', 'deny-tool', 'Not A Tool'])

    expect(result.exitCode).toBe(1)
    expect(result.err).toContain('is not a tool name')
    expect((await cli(config, ['policy', 'export'])).out).not.toContain('Not A Tool')
  })
})
