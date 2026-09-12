import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createFileActionLog } from '../src/adapters/action-log/file-action-log.js'
import { loadConfig, actionsPath } from '../src/config.js'
import { runCli } from '../src/faces/cli/main.js'

it('records local policy changes without copying command arguments into the audit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'buckle-cli-audit-'))
  const config = loadConfig({ BUCKLE_WORKSPACE_ROOT: root, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false' })
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  try {
    expect((await runCli({ argv: ['policy', 'deny-command', 'curl *'], config })).exitCode).toBe(0)
    const entries = createFileActionLog(actionsPath(config)).read(10)
    expect(entries.map(entry => entry.event)).toEqual(['attempt', 'result'])
    expect(entries[1]).toMatchObject({ tool: 'cli_policy', outcome: 'ok' })
    expect(JSON.stringify(entries)).not.toContain('curl *')
  } finally { output.mockRestore() }
})
