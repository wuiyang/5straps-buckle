import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvokeResponse, JsonObject } from '@5straps/protocol'
import type { LogEvent } from '@5straps/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureRootLogger, flushLogs } from '../common/runtime/log.js'
import { logCallFeedback } from '../common/services/invocation/call-feedback.js'
import { renderEvent } from '../common/runtime/log-render.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { createMcpHttpHandlers } from '../mcp/http.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { runCli } from './support/cli.js'
import { shadowGitCheckpoint } from './support/shadow-git-checkpoint.js'
import { workspaceStateKey } from '../common/domain/workspace-key.js'

const opened: CoreRuntime[] = []
afterEach(async () => {
  for (const runtime of opened.splice(0)) {
    runtime.closeWatchers()
    await runtime.cancelInvocations()
    await runtime.approvalService.close()
    await runtime.closeSessions()
    await runtime.history.close()
  }
  await flushLogs()
  configureRootLogger({})
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function fixture(environment: Record<string, string> = {}, serving?: () => boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'buckle-call-feedback-'))
  const root = join(directory, 'workspace')
  mkdirSync(root)
  writeFileSync(join(root, 'private-name-fixture.txt'), 'private-content-fixture')
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: root, BUCKLE_STATE_DIR: join(directory, 'state'), BUCKLE_PACKS: 'fs,code,shell,git,history,web', BUCKLE_ALLOW_SHELL: 'false', ...environment })
  const runtime = await createRuntime({ config, ...(serving ? { serving } : {}) })
  opened.push(runtime)
  return { config, runtime, root }
}

async function capture<T>(run: () => Promise<T>) {
  await flushLogs()
  configureRootLogger({}, { format: 'json' })
  let stderr = ''
  let stdout = ''
  const error = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { stderr += String(chunk); return true })
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { stdout += String(chunk); return true })
  try {
    const result = await run()
    await flushLogs()
    const events = stderr.split('\n').filter(Boolean).map(line => JSON.parse(line) as LogEvent)
    return { result, events, stderr, stdout, calls: events.filter(event => event.message === 'Tool call completed') }
  } finally {
    await flushLogs()
    error.mockRestore()
    output.mockRestore()
  }
}

function invoke(runtime: CoreRuntime, tool: string, args: JsonObject, requestId = 'private-request-fixture') {
  return runtime.invoke({ sessionId: 'private-session-fixture', approvalWait: { mode: 'none' }, request: { requestId, tool, args, approvalTokens: [] } })
}

function message(response: InvokeResponse): string {
  expect(response.outcome).toBe('error')
  if (response.outcome !== 'error') throw new Error('Expected a refused call')
  return response.error.message
}

describe('tool call feedback on the shared logger', () => {
  it('prints one safe summary for a success and its replay, without stdout or call data', async () => {
    const { runtime, root } = await fixture()
    const result = await capture(async () => {
      await invoke(runtime, 'fs_read', { path: 'private-name-fixture.txt' })
      return invoke(runtime, 'fs_read', { path: 'private-name-fixture.txt' })
    })
    expect(result.result.outcome).toBe('ok')
    expect(result.calls).toHaveLength(2)
    expect(result.calls[0]?.fields).toMatchObject({ tool: 'fs_read', outcome: 'ok', durationMs: expect.any(Number), nested: false, replayed: false })
    expect(result.calls[1]?.fields).toMatchObject({ tool: 'fs_read', outcome: 'ok', replayed: true })
    expect(result.stdout).toBe('')
    for (const secret of [root, 'private-name-fixture', 'private-content-fixture', 'private-request-fixture', 'private-session-fixture']) expect(result.stderr).not.toContain(secret)
  })

  it('prints approval-needed, denied, and invalid-input outcomes', async () => {
    const { runtime } = await fixture()
    const result = await capture(async () => {
      await invoke(runtime, 'fs_write', { path: 'new.txt', content: 'private-write-fixture' }, 'ask')
      await runtime.policy.apply({ ...runtime.policy.stored(), tools: { deny: ['fs_read'] } })
      await invoke(runtime, 'fs_read', { path: 'private-name-fixture.txt' }, 'deny')
      await invoke(runtime, 'fs_list', { path: 42 }, 'invalid')
    })
    expect(result.calls.map(event => event.fields?.outcome)).toEqual(['approval_required', 'denied', 'error'])
    expect(result.calls[1]?.fields?.code).toBe('PERMISSION_DENIED')
    expect(result.calls[2]?.fields?.code).toBe('INVALID_TOOL_INPUT')
    expect(result.stderr).not.toContain('private-write-fixture')
    for (const ask of runtime.approvals.pending()) expect(result.stderr).not.toContain(ask.token)
  })

  it('summarizes unexpected failures without logging thrown text or unknown tool names', async () => {
    const { runtime } = await fixture()
    vi.spyOn(runtime.registry().get('fs_read'), 'prepare').mockImplementation(() => { throw Object.assign(new TypeError('private-exception-fixture'), { code: 'EACCES' }) })
    const result = await capture(async () => {
      await invoke(runtime, 'fs_read', { path: 'private-name-fixture.txt' }, 'failed')
      await invoke(runtime, 'private-unknown-tool-fixture', {}, 'unknown')
    })
    expect(result.calls.map(event => event.fields?.outcome)).toEqual(['error', 'error'])
    expect(result.calls[1]?.fields?.tool).toBe('unknown')
    expect(result.events.find(event => event.message === 'Tool invocation failed')?.fields).toEqual({ errorType: 'TypeError', code: 'EACCES' })
    expect(result.stderr).not.toContain('private-exception-fixture')
    expect(result.stderr).not.toContain('private-unknown-tool-fixture')
  })

  it('reports a nonzero shell exit without logging process output', async () => {
    const result = await capture(async () => logCallFeedback({ tool: 'shell_exec', durationMs: 3, response: { requestId: 'shell-failed', outcome: 'ok', output: { exitCode: 7, stdout: 'private-process-output', stderr: 'private-process-error' }, meta: { durationMs: 3, truncated: false } } }))
    expect(result.calls[0]?.fields).toMatchObject({ outcome: 'ok', executionStatus: 'failed', exitCode: 7 })
    expect(renderEvent(result.calls[0]!, { verbose: false })?.[0]).toContain('failed (3ms), exit 7')
    expect(result.stderr).not.toContain('private-process-output')
    expect(result.stderr).not.toContain('private-process-error')
  })

  it('reports a failed code script even when its invocation envelope succeeded', async () => {
    const { runtime } = await fixture()
    const result = await capture(() => invoke(runtime, 'code_run', { script: 'throw new Error("private-script-error")' }))
    expect(result.result.outcome).toBe('ok')
    expect(result.calls[0]?.fields).toMatchObject({ outcome: 'ok', executionStatus: 'failed' })
    expect(renderEvent(result.calls[0]!, { verbose: false })?.[0]).toContain('run code, failed')
    expect(result.stderr).not.toContain('private-script-error')
  })

  it('reports an offline refusal before the invoker runs', async () => {
    const { runtime } = await fixture({}, () => false)
    const result = await capture(async () => { await expect(invoke(runtime, 'fs_list', {})).rejects.toMatchObject({ code: 'WORKSPACE_REFUSED' }) })
    expect(result.calls).toHaveLength(1)
    expect(result.calls[0]?.fields).toMatchObject({ tool: 'fs_list', outcome: 'error', code: 'WORKSPACE_REFUSED' })
  })

  it('reports an audit refusal even when no audit attempt can be stored', async () => {
    const { runtime } = await fixture()
    vi.spyOn(runtime.actions, 'record').mockRejectedValue(new Error('private-audit-fixture'))
    const result = await capture(async () => { await expect(invoke(runtime, 'fs_list', {})).rejects.toThrow('private-audit-fixture') })
    expect(result.calls).toHaveLength(1)
    expect(result.calls[0]?.fields?.outcome).toBe('error')
    expect(result.stderr).not.toContain('private-audit-fixture')
  })

  it('reports each nested code call beside the outer result', async () => {
    const { runtime } = await fixture()
    const result = await capture(() => invoke(runtime, 'code_run', { script: 'return await tools.fs_read({ path: "private-name-fixture.txt" })' }))
    expect(result.result.outcome).toBe('ok')
    expect(result.calls.map(event => [event.fields?.tool, event.fields?.nested])).toEqual([['fs_read', true], ['code_run', false]])
    expect(result.stderr).not.toContain('private-content-fixture')
    expect(result.stderr).not.toContain('private-name-fixture')
  })

  it('renders a short human line with action, outcome, duration, nesting and replay', () => {
    vi.stubEnv('TZ', 'UTC')
    expect(renderEvent({ timestamp: '2026-10-30T14:22:00.000Z', component: 'buckle', level: 'info', message: 'Tool call completed', fields: { tool: 'fs_read', outcome: 'ok', durationMs: 3, nested: true, replayed: true } }, { verbose: false })).toEqual(['14:22:00 [tool] fs_read: read a file, ok (3ms), nested, replayed'])
  })

  it('prints CLI feedback on stderr while stdout stays a valid response', async () => {
    const { config } = await fixture()
    const result = await capture(() => runCli({ argv: ['call', 'fs_read', '--json', '{"path":"private-name-fixture.txt"}'], config }))
    expect(result.result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ content: 'private-content-fixture' })
    expect(result.calls).toHaveLength(1)
  })

  it('prints HTTP MCP feedback without changing the tool response', async () => {
    const workspace = await fixture()
    const handlers = createMcpHttpHandlers()
    try {
      const result = await capture(async () => {
        const response = await handlers.fetch(workspace, new Request('http://127.0.0.1/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'fs_read' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fs_read', arguments: { path: 'private-name-fixture.txt' }, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }) }))
        return response.text()
      })
      expect(result.result).toContain('private-content-fixture')
      expect(result.calls).toHaveLength(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).not.toContain('private-content-fixture')
    } finally { await handlers.close() }
  })
})

describe('permission errors tell the AI how the owner can act', () => {
  it('names the scoped allow-tool command for a tool policy refusal', async () => {
    const { runtime } = await fixture()
    await runtime.policy.apply({ ...runtime.policy.stored(), tools: { deny: ['fs_read'] } })
    const refusal = message(await invoke(runtime, 'fs_read', { path: 'private-name-fixture.txt' }))
    expect(refusal).toContain('buckle policy allow-tool fs_read --workspace ' + runtime.workspaceId)
  })

  it.each([['fs_move', 'fs_write'], ['history_list', 'fs_read']])('names the parent policy blocking %s', async (tool, parent) => {
    const { runtime } = await fixture()
    await runtime.policy.apply({ ...runtime.policy.stored(), tools: { deny: [parent] } })
    const refusal = message(await invoke(runtime, tool, {}))
    expect(refusal).toContain('buckle policy allow-tool ' + parent + ' --workspace ' + runtime.workspaceId)
    expect(refusal).toContain('inherits')
    expect(refusal).not.toContain('buckle policy allow-tool ' + tool + ' --workspace ')
  })

  it('keeps an untrusted tool name out of suggested owner commands', async () => {
    const { runtime } = await fixture()
    await runtime.policy.apply({ ...runtime.policy.stored(), tools: { allow: ['fs_read'], deny: [] } })
    const unsafe = 'private-tool; echo private-payload'
    const refusal = message(await invoke(runtime, unsafe, {}))
    expect(refusal).not.toContain(unsafe)
    expect(refusal).not.toContain('buckle policy allow-tool private-tool;')
    expect(refusal).toContain('buckle policy show --workspace ' + runtime.workspaceId)
  })

  it.each([
    ['shell_exec', { command: 'true' }, {}, 'buckle workspace set packs.shell on'],
    ['code_run', { script: 'return 1' }, { BUCKLE_ALLOW_CODE: 'false' }, 'buckle workspace set packs.code on'],
    ['history_list', {}, { BUCKLE_ALLOW_HISTORY: 'false' }, 'buckle workspace set packs.history on'],
    ['git_status', {}, {}, 'buckle workspace set packs.hostGit on'],
  ] as const)('explains the owner setting for withheld %s', async (tool, args, environment, command) => {
    const { runtime } = await fixture(environment)
    const response = await invoke(runtime, tool, args)
    expect(response).toMatchObject({ outcome: 'error', error: { code: 'TOOL_NOT_FOUND' } })
    expect(message(response)).toContain(command)
    expect(message(response)).toContain('--workspace ' + runtime.workspaceId)
    expect(message(response)).not.toMatch(/dangerously-allow|sandbox.*none|git init/i)
  })

  it('adds a missing history pack while preserving the selected pack list', async () => {
    const { runtime } = await fixture({ BUCKLE_PACKS: 'fs,code' })
    expect(message(await invoke(runtime, 'history_list', {}))).toContain('buckle workspace set packs.enabled fs,code,history --workspace ' + runtime.workspaceId)
  })

  it('distinguishes filesystem policy denials from approval questions', async () => {
    const { runtime } = await fixture()
    await runtime.policy.apply({ ...runtime.policy.stored(), filesystem: { rules: [{ path: 'private-name-fixture.txt', read: 'deny' }] } })
    const refusal = message(await invoke(runtime, 'fs_read', { path: 'private-name-fixture.txt' }))
    expect(refusal).toContain('buckle policy export --workspace ' + runtime.workspaceId)
    expect(refusal).toContain('filesystem rule')
    expect(refusal).toContain('cannot override')
    expect(refusal).not.toMatch(/dangerously-allow|policy clear/)
  })

  it('explains why hash-only history cannot restore and how to enable future capture', async () => {
    const { runtime, root } = await fixture()
    await runtime.history.run({ sessionId: 'history-fixture', tool: 'fs_write', roots: [root] }, async () => { writeFileSync(join(root, 'history-file.txt'), 'changed') })
    expect(runtime.manifest().history).toMatchObject({ engine: 'hashes', restorable: false })
    const response = await invoke(runtime, 'history_restore', { steps: 1 })
    expect(response).toMatchObject({ outcome: 'error', error: { code: 'RESTORE_REFUSED' } })
    const refusal = message(response)
    expect(refusal).toContain('buckle workspace set packs.hostGit on --workspace ' + runtime.workspaceId)
    expect(refusal).toContain('trusted Git installation')
    expect(refusal).toContain('buckle manifest --workspace ' + runtime.workspaceId)
    expect(refusal).toContain('Existing hash-only checkpoints cannot become restorable')
    expect(refusal).not.toMatch(/git init|sandbox.*none|dangerously-allow/i)
  })

  // Slice F2, item 7: an earlier shadow-git checkpoint keeps its content, so permitting host Git does make it restorable.
  it('says an earlier shadow-git checkpoint restores once host git is permitted, never that it cannot become restorable', async () => {
    const { runtime, root, config } = await fixture()
    await shadowGitCheckpoint({ directory: join(config.stateDirectory, 'history', workspaceStateKey(config.cwd)), roots: [root], sessionId: 'history-fixture', stageId: 'old', execute: () => writeFileSync(join(root, 'history-file.txt'), 'changed') })
    const response = await invoke(runtime, 'history_restore', { steps: 1 })
    expect(response).toMatchObject({ outcome: 'error', error: { code: 'RESTORE_REFUSED' } })
    const refusal = message(response)
    expect(refusal).toContain('earlier shadow-git history')
    expect(refusal).toContain('buckle workspace set packs.hostGit on --workspace ' + runtime.workspaceId)
    expect(refusal).toContain('trusted Git installation')
    expect(refusal).toContain('can be restored once host Git is permitted')
    expect(refusal).not.toContain('cannot become restorable')
  })

  it('names a scoped allow-url change without copying URL credentials', async () => {
    const { runtime } = await fixture({ BUCKLE_NETWORK_ALLOW: 'allowed.test' })
    const refusal = message(await invoke(runtime, 'web_fetch', { url: 'https://other.test/private-query?access_token=private-value' }))
    expect(refusal).toContain('buckle policy allow-url <host-or-url-prefix> --workspace ' + runtime.workspaceId)
    expect(refusal).not.toContain('private-password')
    expect(refusal).not.toContain('private-value')
  })
})
