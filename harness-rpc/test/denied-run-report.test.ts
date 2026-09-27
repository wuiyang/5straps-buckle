import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActionReport, DeniedRunReport } from '@5straps/protocol'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../common/runtime/config.js'
import type { Reporter } from '../common/types/ports/reporter.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'

let runtime: BuckleRuntime
let reports: DeniedRunReport[]
let recorded: ActionReport[]
let workspace: string

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'buckle-report-ws-'))
  writeFileSync(join(workspace, 'a.txt'), 'a')
  reports = []
  recorded = []
  const reporter: Reporter = {
    configured: true,
    report: async report => { reports.push(report) },
    record: entry => { recorded.push(entry) },
    flush: () => Promise.resolve(),
  }
  const config = loadConfig({
    BUCKLE_AUTH_TOKEN: 'agent',
    BUCKLE_SERVER_ID: 'node-1',
    BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'buckle-report-state-')),
    BUCKLE_WORKSPACE_ROOT: workspace,
    BUCKLE_ALLOW_SHELL: 'false',
  })
  runtime = await createRuntime({ config, reporter })
})

async function invoke(tool: string, args: Record<string, unknown>) {
  return runtime.invoke({ request: { requestId: 'req-1', tool, args: args as Record<string, never>, approvalTokens: [] }, sessionId: 'chat-9' })
}

describe('a refused call', () => {
  it('is reported as it happens, with what was tried and which rule refused it', async () => {
    const response = await invoke('web_fetch', { url: 'file:///etc/passwd' })
    expect(response.outcome).toBe('error')

    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      event: 'denied_run',
      serverId: 'node-1',
      workspace,
      requestId: 'req-1',
      sessionId: 'chat-9',
      tool: 'web_fetch',
      rule: 'network_egress',
      subject: 'file:',
    })
    expect(reports[0]?.effects).toEqual(['network'])
  })
})

describe('a call that ran, or one that merely asked', () => {
  it('is not announced as a refusal', async () => {
    expect((await invoke('fs_read', { path: 'a.txt' })).outcome).toBe('ok')
    expect((await invoke('fs_read', { path: '/etc/hostname' })).outcome).toBe('approval_required')
    expect(reports).toHaveLength(0)
  })
})

describe('the action log Buckle reports', () => {
  it('carries every entry with its own outcome, whatever became of the call', async () => {
    await invoke('fs_read', { path: 'a.txt' })
    await invoke('fs_read', { path: '/etc/hostname' })
    await invoke('web_fetch', { url: 'file:///etc/passwd' })
    await invoke('fs_read', { path: 'missing.txt' })

    expect(recorded.map(entry => entry.outcome)).toEqual(['ok', 'approval_required', 'denied', 'error'])
    expect(recorded.every(entry => entry.workspace === workspace && entry.workspaceId === 'default')).toBe(true)
    expect(recorded[2]).toMatchObject({ tool: 'web_fetch', rule: 'network_egress', subject: 'file:' })
    expect(recorded[0]).toMatchObject({ tool: 'fs_read', rule: null, reason: '' })
  })

  it("never carries an argument's text, only its length", async () => {
    await invoke('fs_write', { path: 'secret.txt', content: 'ghp_0123456789abcdef' })

    expect(JSON.stringify(recorded)).not.toContain('ghp_')
    expect(recorded[0]?.args).toMatchObject({ content: '[20 characters]' })
  })
})

describe('the reporting configuration', () => {
  it('needs the URL and the token together', () => {
    expect(() => loadConfig({ BUCKLE_REPORT_URL: 'http://rings.test/api/v1/buckle-reports' })).toThrow(/together/)
  })
})
