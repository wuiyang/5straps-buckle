import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { serveStdio, type ServeStdioOptions } from '@modelcontextprotocol/server/stdio'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { startActionLogWriter, auditEntries } from './support/action-log-writer.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { createStdioWire } from '../mcp/stdio-wire.js'
import { createAuditedStdioTransport } from '../mcp/audited-stdio-transport.js'
import { createMcpServer } from '../mcp/server.js'
import { configureRootLogger, flushLogs } from '../common/runtime/log.js'
import type { ActionLog, ActionLogEntry } from '../common/types/ports/action-log.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'

type Transport = NonNullable<ServeStdioOptions['transport']>
type Message = Parameters<Transport['send']>[0]
const cleanup: Array<() => unknown | Promise<unknown>> = []
beforeAll(startActionLogWriter)
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); vi.restoreAllMocks() })

async function sdkFixture() {
  const root = mkdtempSync(join(tmpdir(), 'buckle-mcp-audit-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'private-filename-fixture.txt'), 'private-output-fixture')
  const state = mkdtempSync(join(tmpdir(), 'buckle-mcp-audit-state-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: root, BUCKLE_STATE_DIR: state, BUCKLE_ALLOW_SHELL: 'false' })
  const runtime = await createRuntime({ config })
  const invoke = vi.spyOn(runtime, 'invoke')
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const replies: Record<string, unknown>[] = []
  stdout.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').trim().split('\n')) replies.push(JSON.parse(line) as Record<string, unknown>)
  })
  const transport = createAuditedStdioTransport({ transport: createStdioWire({ stdin, stdout, maxBufferBytes: 1_048_576 }), actions: runtime.actions, workspaceId: 'default', isKnownTool: name => runtime.registry().has(name) })
  const handle = serveStdio(() => createMcpServer({ runtime, serverName: 'audit-test', version: '0.0.0' }), { transport })
  cleanup.push(async () => { await handle.close(); stdin.destroy(); stdout.destroy() })
  const call = async (id: string | number, method: string, params: Record<string, unknown>) => {
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    await vi.waitFor(() => expect(replies.some(reply => reply['id'] === id)).toBe(true))
    return replies.find(reply => reply['id'] === id)!
  }
  await call(0, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'audit-test', version: '0.0.0' } })
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  return { runtime, invoke, call, stdin, replies, entries: () => auditEntries(runtime.actions, 100) }
}

describe('stdio audit before MCP SDK validation', () => {
  it('records schema and unknown-tool rejections without invoking tools or exposing request payloads', async () => {
    const fixture = await sdkFixture()
    await fixture.call('private-request-id-fixture', 'tools/call', { name: 'fs_read', arguments: { path: 42, secret: 'private-arg-fixture' } })
    await fixture.call(2, 'tools/call', { name: 'private-unknown-tool-fixture', arguments: { secret: 'private-arg-fixture' } })
    expect(fixture.invoke).not.toHaveBeenCalled()
    const entries = (await fixture.entries()).filter(entry => entry.tool === 'mcp_stdio_tools_call')
    expect(entries.map(entry => entry.event)).toEqual(['attempt', 'result', 'attempt', 'result'])
    expect(entries.filter(entry => entry.event === 'result').every(entry => entry.outcome === 'error')).toBe(true)
    expect(entries[0]?.auditId).toBe(entries[1]?.auditId)
    expect(entries[2]?.auditId).toBe(entries[3]?.auditId)
    expect(entries[0]?.auditId).not.toBe(entries[2]?.auditId)
    for (const secret of ['private-request-id-fixture', 'private-arg-fixture', 'private-unknown-tool-fixture']) expect(JSON.stringify(entries)).not.toContain(secret)
  })

  it('logs one truthful summary for a valid tool call that fails', async () => {
    const fixture = await sdkFixture()
    await flushLogs()
    configureRootLogger({}, { format: 'json' })
    let stderr = ''
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { stderr += String(chunk); return true })
    try {
      await fixture.call(1, 'tools/call', { name: 'fs_read', arguments: { path: 'private-missing-file.txt' } })
      await flushLogs()
      const calls = stderr.split('\n').filter(Boolean).map(line => JSON.parse(line) as { message: string; fields?: Record<string, unknown> }).filter(event => event.message === 'Tool call completed')
      expect(calls.map(event => [event.fields?.tool, event.fields?.outcome, event.fields?.code])).toEqual([['fs_read', 'error', 'FILE_NOT_FOUND']])
      expect(stderr).not.toContain('private-missing-file.txt')
      expect(fixture.invoke).toHaveBeenCalledOnce()
    } finally { spy.mockRestore(); configureRootLogger({}) }
  })

  it('keeps correlated transport and semantic audit records for a valid call without output contents', async () => {
    const fixture = await sdkFixture()
    await fixture.call(1, 'tools/call', { name: 'fs_read', arguments: { path: 'private-filename-fixture.txt' } })
    expect(fixture.invoke).toHaveBeenCalledOnce()
    const entries = await fixture.entries()
    const transport = entries.filter(entry => entry.tool === 'mcp_stdio_tools_call')
    const semantic = entries.filter(entry => entry.tool === 'fs_read')
    expect(transport.map(entry => entry.outcome)).toEqual(['started', 'ok'])
    expect(semantic.map(entry => entry.outcome)).toEqual(['started', 'ok'])
    expect(transport[0]?.auditId).toBe(transport[1]?.auditId)
    expect(transport[0]?.auditId).not.toBe(semantic[0]?.auditId)
    expect(JSON.stringify(entries)).not.toContain('private-filename-fixture')
    expect(JSON.stringify(entries)).not.toContain('private-output-fixture')
  })

  it('records malformed framing generically and never retains parser error text', async () => {
    const fixture = await sdkFixture()
    fixture.stdin.write('{"private-parser-fixture": invalid}\n')
    await vi.waitFor(async () => expect((await fixture.entries()).some(entry => entry.tool === 'mcp_stdio_transport_error' && entry.event === 'result')).toBe(true))
    expect(fixture.invoke).not.toHaveBeenCalled()
    expect(JSON.stringify(await fixture.entries())).not.toContain('private-parser-fixture')
  })
})

function fakeFixture(record?: (entry: ActionLogEntry) => void | Promise<void>) {
  const entries: ActionLogEntry[] = []
  const actions: ActionLog = { record: async entry => { await record?.(entry); entries.push(entry) }, append: entry => { entries.push(entry) }, recordMany: async batch => { for (const entry of batch) await actions.record(entry) }, recoverInterrupted: async () => 0, read: () => entries, page: () => ({ entries, nextCursor: null }) }
  const wire: Transport = { start: vi.fn(async () => undefined), close: vi.fn(async () => { wire.onclose?.() }), send: vi.fn(async () => undefined) }
  const transport = createAuditedStdioTransport({ transport: wire, actions, workspaceId: 'default', isKnownTool: name => name === 'fs_read' })
  const forwarded = vi.fn()
  transport.onmessage = forwarded
  const request = (id: string | number): Message => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'fs_read', arguments: { path: 'never-record-this' } } })
  return { wire, transport, forwarded, entries, request }
}

// Inbound handling is asynchronous now that audit writes are; a macrotask turn lets every queued step run.
function settle(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

describe('stdio audit ordering', () => {
  it('dispatches each request only after its attempt is durable, one at a time in arrival order', async () => {
    const releases: Array<() => void> = []
    const fixture = fakeFixture(entry => entry.event === 'attempt' ? new Promise<void>(resolve => { releases.push(resolve) }) : undefined)
    fixture.wire.onmessage?.(fixture.request(1))
    fixture.wire.onmessage?.(fixture.request(2))
    await settle()
    expect(fixture.forwarded).not.toHaveBeenCalled()
    expect(releases).toHaveLength(1)

    releases[0]!()
    await settle()
    expect(fixture.forwarded).toHaveBeenCalledTimes(1)
    expect(fixture.forwarded.mock.calls[0]![0]).toMatchObject({ id: 1 })
    expect(releases).toHaveLength(2)

    releases[1]!()
    await settle()
    expect(fixture.forwarded).toHaveBeenCalledTimes(2)
    expect(fixture.forwarded.mock.calls[1]![0]).toMatchObject({ id: 2 })
  })
})

describe('stdio audit failure and correlation bounds', () => {
  it('closes before dispatch if an attempt cannot be durably recorded', async () => {
    const fixture = fakeFixture(() => { throw new Error('fixture failure') })
    fixture.wire.onmessage?.(fixture.request(1))
    await settle()
    expect(fixture.forwarded).not.toHaveBeenCalled()
    expect(fixture.wire.close).toHaveBeenCalledOnce()
    fixture.wire.onmessage?.(fixture.request(2))
    await settle()
    expect(fixture.forwarded).not.toHaveBeenCalled()
  })

  it('withholds a response and closes if the terminal audit write fails', async () => {
    const fixture = fakeFixture(entry => { if (entry.event === 'result') throw new Error('fixture failure') })
    fixture.wire.onmessage?.(fixture.request(1))
    await settle()
    await expect(fixture.transport.send({ jsonrpc: '2.0', id: 1, result: { content: [] } })).rejects.toThrow('audit persistence failed')
    expect(fixture.wire.send).not.toHaveBeenCalled()
    expect(fixture.wire.close).toHaveBeenCalledOnce()
  })

  it('correlates overlapping request replies even when responses arrive out of order', async () => {
    const fixture = fakeFixture()
    fixture.wire.onmessage?.(fixture.request(1))
    fixture.wire.onmessage?.(fixture.request(2))
    await settle()
    await fixture.transport.send({ jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'private-server-error-fixture' } })
    await fixture.transport.send({ jsonrpc: '2.0', id: 1, result: { content: [] } })
    expect(fixture.entries[0]?.auditId).toBe(fixture.entries[3]?.auditId)
    expect(fixture.entries[1]?.auditId).toBe(fixture.entries[2]?.auditId)
    expect(JSON.stringify(fixture.entries)).not.toContain('private-server-error-fixture')
  })

  it('rejects duplicate in-flight identifiers and marks the earlier request interrupted', async () => {
    const fixture = fakeFixture()
    fixture.wire.onmessage?.(fixture.request(1))
    fixture.wire.onmessage?.(fixture.request(1))
    await settle()
    expect(fixture.forwarded).toHaveBeenCalledOnce()
    expect(fixture.entries.map(entry => entry.outcome)).toEqual(['started', 'started', 'denied', 'interrupted'])
  })

  it('bounds pending requests and rejects tool notifications without an identifier', async () => {
    const fixture = fakeFixture()
    fixture.wire.onmessage?.({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'fs_read' } })
    await settle()
    expect(fixture.forwarded).not.toHaveBeenCalled()
    for (let id = 0; id <= 256; id += 1) fixture.wire.onmessage?.(fixture.request(id))
    await settle()
    expect(fixture.forwarded).toHaveBeenCalledTimes(256)
    expect(fixture.wire.close).toHaveBeenCalledOnce()
    expect(fixture.entries.filter(entry => entry.outcome === 'interrupted')).toHaveLength(256)
  })
})
