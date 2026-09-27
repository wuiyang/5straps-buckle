import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyWorkspacePolicy } from '@5straps/protocol'
import { describe, expect, it, vi } from 'vitest'
import { createDeferredApprovalChannel } from '../src/adapters/approval/deferred-approval-channel.js'
import { createFilePolicyStore } from '../src/adapters/policy-store/file-policy-store.js'
import { loadConfig, policyPath, type BuckleConfig } from '../src/config.js'
import { runCli } from '../src/faces/cli/main.js'
import { createRuntime } from '../src/runtime.js'

/** A node whose stored approved list holds these entries, written straight to the store. */
function withStoredList(allow: string[]): BuckleConfig {
  const config = loadConfig({
    BUCKLE_WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), 'buckle-approved-list-')),
    BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'buckle-approved-list-state-')),
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

describe('the approved list in the stored policy', () => {
  it('refuses to load a stored entry the host grammar refuses', async () => {
    const config = withStoredList(['example.com', '*.127.0.0.1'])
    await expect(createRuntime({ config, channel: () => createDeferredApprovalChannel() })).rejects.toThrow('A wildcard covers a domain, not an address')
  })

  it('refuses a new entry the host grammar refuses and keeps the stored list', async () => {
    const config = withStoredList(['example.com'])
    const added = await run(config, 'policy', 'allow-url', '*.0.0.1')

    expect(added.exitCode).toBe(1)
    expect(added.stderr).toContain('A wildcard covers a domain, not an address: *.0.0.1')
    expect(store(config).read()?.network.allow).toEqual(['example.com'])
  })

  it('says so when policy remove takes out the last entry, because an empty list is no list', async () => {
    const config = withStoredList(['docs.test'])

    const removed = await run(config, 'policy', 'remove', 'docs.test')

    expect(removed.exitCode).toBe(0)
    expect(removed.stdout).toContain('The approved list is now empty, which is no list')
    expect(store(config).read()?.network.allow).toEqual([])
  })
})
