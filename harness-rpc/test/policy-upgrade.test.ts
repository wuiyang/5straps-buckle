import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyWorkspacePolicy } from '@5straps/protocol'
import { describe, expect, it, vi } from 'vitest'
import { createFilePolicyStore } from '../src/adapters/policy-store/file-policy-store.js'
import { loadConfig, policyPath, type BuckleConfig } from '../src/config.js'
import { runCli } from '../src/faces/cli/main.js'

/** A node whose stored approved list was written before `BUCKLE-D18` tightened the host grammar. */
function upgraded(allow: string[]): BuckleConfig {
  const config = loadConfig({
    BUCKLE_WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), 'buckle-policy-upgrade-')),
    BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'buckle-policy-upgrade-state-')),
    BUCKLE_ALLOW_SHELL: 'false',
  })
  const policy = emptyWorkspacePolicy()
  policy.network.allow = allow
  store(config).write(policy)
  return config
}

function store(config: BuckleConfig) {
  return createFilePolicyStore({ filePath: policyPath(config), workspace: config.cwd })
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

describe('a stored approved-list entry the host grammar now refuses (BUCKLE-D18 upgrade)', () => {
  it('lets policy show run, marking the entry as skipped', async () => {
    const shown = await run(upgraded(['example.com', '*.127.0.0.1']), 'policy', 'show')

    expect(shown.exitCode).toBe(0)
    expect(shown.stdout).toMatch(/example\.com\s+stored\n/)
    expect(shown.stdout).toMatch(/\*\.127\.0\.0\.1\s+stored {2}SKIPPED, covers nothing: A wildcard covers a domain, not an address/)
  })

  it('lets policy remove and policy clear run', async () => {
    const config = upgraded(['example.com', '*.127.0.0.1'])
    expect((await run(config, 'policy', 'remove', '*.127.0.0.1')).exitCode).toBe(0)
    expect(store(config).read()?.network.allow).toEqual(['example.com'])

    const cleared = upgraded(['*.127.0.0.1'])
    expect((await run(cleared, 'policy', 'clear')).exitCode).toBe(0)
    expect(store(cleared).read()).toBeNull()
  })

  it('fails closed for that entry: the rest of the list applies, and a list left empty reaches nothing', async () => {
    const config = upgraded(['example.com', '*.127.0.0.1'])
    expect((await run(config, 'check-url', 'http://127.0.0.1/')).exitCode).toBe(1)
    expect((await run(config, 'check-url', 'https://example.com/')).exitCode).toBe(0)
    expect((await run(upgraded(['*.127.0.0.1']), 'check-url', 'https://example.com/')).exitCode).toBe(1)
  })

  it('still refuses the same entry when it is newly added', async () => {
    const config = upgraded(['*.127.0.0.1'])
    const added = await run(config, 'policy', 'allow-url', '*.0.0.1')

    expect(added.exitCode).toBe(1)
    expect(added.stderr).toContain('A wildcard covers a domain, not an address: *.0.0.1')
    expect(store(config).read()?.network.allow).toEqual(['*.127.0.0.1'])
  })

  it('is reported by policy migrate, and dropped by policy migrate --write', async () => {
    const config = upgraded(['example.com', '*.127.0.0.1'])

    const dry = await run(config, 'policy', 'migrate')
    expect(dry.exitCode).toBe(0)
    expect(dry.stdout).toMatch(/\*\.127\.0\.0\.1\s+-> remove \(A wildcard covers a domain, not an address/)
    expect(store(config).read()?.network.allow).toEqual(['example.com', '*.127.0.0.1'])

    expect((await run(config, 'policy', 'migrate', '--write')).exitCode).toBe(0)
    expect(store(config).read()?.network.allow).toEqual(['example.com'])
    expect((await run(config, 'policy', 'migrate')).stdout).toContain('there is nothing to migrate')
  })

  it('refuses a migrate --write that would empty the list, so a list that reached nothing never opens every public host', async () => {
    const config = upgraded(['*.127.0.0.1', '*.1'])

    const dry = await run(config, 'policy', 'migrate')
    expect(dry.stdout).toContain('an empty list is no list')

    const written = await run(config, 'policy', 'migrate', '--write')
    expect(written.exitCode).toBe(1)
    expect(written.stderr).toContain('Nothing written')
    expect(written.stderr).toContain('buckle policy clear')
    expect(store(config).read()?.network.allow).toEqual(['*.127.0.0.1', '*.1'])
    for (const url of ['https://example.com/', 'https://evil.test/']) expect((await run(config, 'check-url', url)).exitCode).toBe(1)

    expect((await run(config, 'policy', 'allow-url', 'docs.test')).exitCode).toBe(0)
    expect((await run(config, 'policy', 'migrate', '--write')).exitCode).toBe(0)
    expect(store(config).read()?.network.allow).toEqual(['docs.test'])
    expect((await run(config, 'check-url', 'https://example.com/')).exitCode).toBe(1)
  })

  it('says so when policy remove takes out the last entry, because an empty list is no list', async () => {
    const config = upgraded(['*.127.0.0.1'])

    const removed = await run(config, 'policy', 'remove', '*.127.0.0.1')

    expect(removed.exitCode).toBe(0)
    expect(removed.stdout).toContain('The approved list is now empty, which is no list')
    expect(store(config).read()?.network.allow).toEqual([])
  })
})
