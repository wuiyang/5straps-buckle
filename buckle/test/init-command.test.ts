import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runInitCommand } from '../cli/main.js'
import { settleAuditLogs } from './support/action-log-writer.js'

// buckle init as the command line runs it: the node's config is loaded first, only for where the audit log lives.
// Every workspace default is read from the node's file alone, so a shell that sets one wrongly is no reason to refuse
// (fix brief 5, item 14); a node setting the shell does set still refuses before anything is written.

let root: string
let out: string
let workspace: string
let printed: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-init-command-')))
  out = join(root, 'node.env')
  workspace = join(root, 'workspace')
  mkdirSync(workspace)
  printed = ''
  vi.stubEnv('BUCKLE_STATE_DIR', join(root, 'state'))
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { printed += String(chunk); return true })
})
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await settleAuditLogs(); rmSync(root, { recursive: true, force: true }) })

const argv = () => ['--out', out, '--port', '4399', '--yes', '--dir', workspace, '--name', 'Fixture']

describe('buckle init, the command', () => {
  it.each([
    ['BUCKLE_BROWSER_CDP', 'not-a-port'],
    ['BUCKLE_MOUNTS', '::bad'],
    ['BUCKLE_ALLOWED_HOSTS', 'not a host'],
    ['BUCKLE_BROWSER_PROFILE', 'relative/profile'],
  ])('reads no workspace default from the shell: %s set wrongly there refuses nothing', async (key, value) => {
    vi.stubEnv(key, value)

    expect((await runInitCommand(argv())).exitCode).toBe(0)
    expect(parseEnv(readFileSync(out, 'utf8'))[key]).toBeUndefined()
  })

  it('still refuses before it writes anything where the shell sets a node setting the node does read, wrongly', () => {
    vi.stubEnv('BUCKLE_REPORT_URL', 'https://rings.example')

    expect(() => runInitCommand(argv())).toThrow('BUCKLE_REPORT_URL and BUCKLE_REPORT_TOKEN must be configured together')
    expect(existsSync(out)).toBe(false)
  })
})
