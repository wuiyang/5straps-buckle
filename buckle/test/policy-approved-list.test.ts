import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyWorkspacePolicy } from '@5straps/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { BuckleConfig } from '../common/runtime/config.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { readFileSync, writeFileSync } from 'node:fs'
import { runCli } from './support/cli.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { openSettingsFile, settingsPath } from '../common/services/workspaces/workspace-settings.js'
import { workspacesOf } from './support/workspaces.js'

/**
 * A node whose workspace default's approved list holds these entries, written straight to its workspace.json past the
 * check every write makes, as a file a later grammar refuses would read.
 */
async function withStoredList(allow: string[], node: Record<string, string> = {}): Promise<BuckleConfig> {
  const config = configFromEnvironment({
    BUCKLE_WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), 'buckle-approved-list-')),
    BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'buckle-approved-list-state-')),
    BUCKLE_ALLOW_SHELL: 'false',
    ...node,
  })
  await workspacesOf(config)
  const settings = JSON.parse(readFileSync(file(config), 'utf8')) as { policy: ReturnType<typeof emptyWorkspacePolicy> }
  settings.policy.network.allow = allow
  writeFileSync(file(config), JSON.stringify(settings))
  return config
}

function file(config: BuckleConfig): string {
  return settingsPath(config.nodeStateDirectory!, config.workspaceId)
}

function store(config: BuckleConfig) {
  return { read: () => openSettingsFile({ filePath: file(config) }).read().policy }
}

async function run(config: BuckleConfig, ...argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { stdout += String(chunk); return true })
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { stderr += String(chunk); return true })
  try {
    return { exitCode: (await runCli({ argv, config })).exitCode, stdout, stderr }
  } finally {
    out.mockRestore()
    err.mockRestore()
  }
}

describe('the approved list in the stored policy', () => {
  it('refuses to load a stored entry the host grammar refuses', async () => {
    const config = await withStoredList(['example.com', '*.127.0.0.1'])
    await expect(createRuntime({ config })).rejects.toThrow('A wildcard covers a domain, not an address')
  })

  it('refuses a new entry the host grammar refuses and keeps the stored list', async () => {
    const config = await withStoredList(['example.com'])
    const added = await run(config, 'policy', 'allow-url', '*.0.0.1')

    expect(added.exitCode).toBe(1)
    expect(added.stderr).toContain('A wildcard covers a domain, not an address: *.0.0.1')
    expect(store(config).read().network.allow).toEqual(['example.com'])
  })

  it('says so when policy remove takes out the last entry, because an empty list is no list', async () => {
    const config = await withStoredList(['docs.test'])

    const removed = await run(config, 'policy', 'remove', 'docs.test')

    expect(removed.exitCode).toBe(0)
    expect(removed.stdout).toContain('The approved list is now empty, which is no list')
    expect(store(config).read().network.allow).toEqual([])
  })

  // D85, Q14: an emptied list of the workspace's own is no list of its own, so the node's stands for it.
  it('says the node\'s approved list applies once policy remove empties the workspace\'s own, and clear names the node\'s lists', async () => {
    const config = await withStoredList(['docs.test'], { BUCKLE_NETWORK_ALLOW: 'node.test' })

    const removed = await run(config, 'policy', 'remove', 'docs.test')
    expect(removed.stdout).toContain('The workspace\'s own approved list is now empty, which is no list of its own: the node\'s approved list in buckle.env applies.')
    expect(removed.stdout).not.toContain('the default network rules reach public hosts')
    const cleared = await run(config, 'policy', 'clear')
    expect(cleared.stdout).toContain('The node\'s lists in buckle.env apply in their place, and its deny lists apply to every workspace')
  })

  it('names the stored policy file, the refused entry and the fix when that entry stops the node', async () => {
    const config = await withStoredList(['example.com', '*.127.0.0.1'])
    const failure = await run(config, 'tools').catch((error: unknown) => error as Error)

    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toContain(file(config))
    expect(message).toContain('A wildcard covers a domain, not an address: *.127.0.0.1')
    expect(message).toContain('buckle policy remove *.127.0.0.1')
    expect(message).not.toContain('empty')
  })

  it('warns in that message when the refused entries are the whole approved list', async () => {
    const config = await withStoredList(['*.127.0.0.1'])
    const failure = await run(config, 'tools').catch((error: unknown) => error as Error)

    expect((failure as Error).message).toContain('an empty approved list is no list')
  })

  it('lets policy remove repair a stored entry the node cannot load, and the node loads again', async () => {
    const config = await withStoredList(['example.com', '*.127.0.0.1'])

    const removed = await run(config, 'policy', 'remove', '*.127.0.0.1')

    expect(removed.exitCode).toBe(0)
    expect(store(config).read().network.allow).toEqual(['example.com'])
    expect((await run(config, 'tools')).exitCode).toBe(0)
  })

  it('warns when that repair leaves the approved list empty', async () => {
    const config = await withStoredList(['*.127.0.0.1'])

    const removed = await run(config, 'policy', 'remove', '*.127.0.0.1')

    expect(removed.exitCode).toBe(0)
    expect(removed.stdout).toContain('The approved list is now empty, which is no list')
  })

  it('refuses a repair that still leaves the stored policy unloadable', async () => {
    const config = await withStoredList(['*.127.0.0.1', '*.0.0.1'])

    const removed = await run(config, 'policy', 'remove', '*.127.0.0.1')

    expect(removed.exitCode).toBe(1)
    expect(removed.stderr).toContain('*.0.0.1')
    expect(store(config).read().network.allow).toEqual(['*.127.0.0.1', '*.0.0.1'])
  })

  it('lets policy clear, show and export run on a stored policy the node cannot load', async () => {
    const config = await withStoredList(['example.com', '*.127.0.0.1'])

    const shown = await run(config, 'policy', 'show')
    expect(shown.exitCode).toBe(1)
    expect(shown.stderr).toContain('buckle policy remove *.127.0.0.1')
    expect(JSON.parse(shown.stdout).network.allow).toEqual(['example.com', '*.127.0.0.1'])
    const exported = await run(config, 'policy', 'export')
    expect(exported.exitCode).toBe(0)
    expect(JSON.parse(exported.stdout).network.allow).toEqual(['example.com', '*.127.0.0.1'])

    const cleared = await run(config, 'policy', 'clear')
    expect(cleared.exitCode).toBe(0)
    expect(store(config).read().network.allow).toEqual([])
    expect(readFileSync(file(config), 'utf8')).not.toContain('127.0.0.1')
  })

  it('refuses other policy edits until the stored policy loads', async () => {
    const config = await withStoredList(['*.127.0.0.1'])

    const added = await run(config, 'policy', 'allow-url', 'example.com')

    expect(added.exitCode).toBe(1)
    expect(added.stderr).toContain('buckle policy remove *.127.0.0.1')
    expect(store(config).read().network.allow).toEqual(['*.127.0.0.1'])
  })
})
