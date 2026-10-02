import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createFileActionLog } from '../common/adapters/action-log/file-action-log.js'
import { loadConfig, actionsPath } from '../common/runtime/config.js'
import { runCli } from '../cli/main.js'

it('records local policy changes without copying command arguments into the audit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'buckle-cli-audit-'))
  const config = loadConfig({ BUCKLE_WORKSPACE_ROOT: root, BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'buckle-cli-audit-state-')), BUCKLE_ALLOW_SHELL: 'false' })
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  try {
    expect((await runCli({ argv: ['policy', 'deny-command', 'curl *'], config })).exitCode).toBe(0)
    const entries = createFileActionLog(actionsPath(config)).read(10)
    expect(entries.map(entry => entry.event)).toEqual(['attempt', 'result'])
    expect(entries[1]).toMatchObject({ tool: 'cli_policy', outcome: 'ok' })
    expect(JSON.stringify(entries)).not.toContain('curl *')
  } finally { output.mockRestore() }
})

it('records which tool a deny-tool or allow-tool switch named', async () => {
  const root = mkdtempSync(join(tmpdir(), 'buckle-cli-audit-'))
  const config = loadConfig({ BUCKLE_WORKSPACE_ROOT: root, BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'buckle-cli-audit-state-')), BUCKLE_ALLOW_SHELL: 'false' })
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  try {
    expect((await runCli({ argv: ['policy', 'deny-tool', 'fs_write'], config })).exitCode).toBe(0)
    expect((await runCli({ argv: ['policy', 'allow-tool', 'fs_write'], config })).exitCode).toBe(0)
    const results = createFileActionLog(actionsPath(config)).read(10).filter(entry => entry.event === 'result')
    expect(results.map(entry => [entry.tool, entry.detail])).toEqual([['cli_policy', 'deny-tool fs_write'], ['cli_policy', 'allow-tool fs_write']])
  } finally { output.mockRestore() }
})
