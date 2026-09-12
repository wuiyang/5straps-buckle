import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeniedRunReport } from '@5straps/protocol'
import { beforeEach, describe, expect, it } from 'vitest'
import { createDeferredApprovalChannel } from '../src/adapters/approval/deferred-approval-channel.js'
import { loadConfig } from '../src/config.js'
import type { Reporter } from '../src/ports/reporter.js'
import { createRuntime, type BuckleRuntime } from '../src/runtime.js'

let runtime: BuckleRuntime
let reports: DeniedRunReport[]
let workspace: string

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'buckle-report-ws-'))
  writeFileSync(join(workspace, 'a.txt'), 'a')
  reports = []
  const reporter: Reporter = {
    configured: true,
    report: async report => { reports.push(report) },
  }
  const config = loadConfig({
    BUCKLE_AUTH_TOKEN: 'agent',
    BUCKLE_SERVER_ID: 'node-1',
    BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'buckle-report-state-')),
    BUCKLE_WORKSPACE_ROOT: workspace,
    BUCKLE_ALLOW_SHELL: 'false',
  })
  runtime = await createRuntime({ config, channel: () => createDeferredApprovalChannel(), reporter })
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
  it('is not reported', async () => {
    expect((await invoke('fs_read', { path: 'a.txt' })).outcome).toBe('ok')
    expect((await invoke('fs_read', { path: '/etc/hostname' })).outcome).toBe('approval_required')
    expect(reports).toHaveLength(0)
  })
})

describe('the reporting configuration', () => {
  it('needs the URL and the token together', () => {
    expect(() => loadConfig({ BUCKLE_REPORT_URL: 'http://rings.test/api/v1/buckle-reports' })).toThrow(/together/)
  })
})
