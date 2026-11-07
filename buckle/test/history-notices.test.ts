import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { createMcpHttpHandlers } from '../mcp/http.js'
import { copyCommand } from '../cli/copy.js'
import { runCli } from './support/cli.js'
import { configFromEnvironment } from './support/workspace-config.js'

const roots: string[] = []
const runtimes: CoreRuntime[] = []
const servers: Server[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  for (const runtime of runtimes.splice(0)) { runtime.closeWatchers(); await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function workspace(hostGit: boolean, environment: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'history-notice-')); roots.push(root)
  const path = join(root, 'workspace'); mkdirSync(path)
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: path, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_ALLOW_HOST_GIT: String(hostGit), BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '1', ...environment })
  const runtime = await createRuntime({ config }); runtimes.push(runtime)
  return { path, config, runtime }
}

async function mcpWrite(node: Awaited<ReturnType<typeof workspace>>) {
  await node.runtime.grants.grant({ sessionId: 'mcp', rule: 'write_scope', subject: node.runtime.paths().root, scope: 'session' })
  const request = new Request('http://localhost/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'fs_write' }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'fs_write', arguments: { path: 'note.txt', content: 'hello' }, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }) })
  const response = await createMcpHttpHandlers().fetch(node, request)
  const body = await response.text()
  const json = response.headers.get('content-type')?.includes('text/event-stream') ? JSON.parse(body.split('\n').find(line => line.startsWith('data:'))!.slice(5)) : JSON.parse(body)
  return json.result as { content: Array<{ text: string }>; _meta?: Record<string, unknown> }
}

// A file tool's checkpoint keeps its content in history's own object store (Slice F2, items 1 and 4), so host git off
// leaves an fs_write restorable, with nothing to warn of; a file over the content cap still warns.
it('MCP adds no history warning after a real write without host git', async () => {
  const node = await workspace(false)
  const result = await mcpWrite(node)
  expect(readFileSync(join(node.path, 'note.txt'), 'utf8')).toBe('hello')
  expect(result.content[1]).toBeUndefined()
  expect(result._meta?.['5straps/history']).toBeUndefined()
})

it.each([['host git disabled', false], ['host git allowed', true]] as const)('MCP warns after a real write over the file cap with %s', async (_label, hostGit) => {
  const node = await workspace(hostGit)
  node.runtime.history.configure({ maxFileBytes: 1 })
  const result = await mcpWrite(node)
  expect(readFileSync(join(node.path, 'note.txt'), 'utf8')).toBe('hello')
  expect(JSON.parse(result.content[0]!.text)).toBeTruthy()
  expect(result.content[1]?.text).toMatch(/history.*(restore|restorable)/i)
  expect(result._meta?.['5straps/history']).toMatchObject({ checkpoint: expect.stringMatching(/^change-/) })
})

it('CLI keeps tool JSON on stdout and warns on stderr after a real write over the file cap without host git', async () => {
  const node = await workspace(false, { BUCKLE_ADMIN_TOKEN: 'history-notices-admin-credential' })
  await node.runtime.grants.grant({ sessionId: 'cli', rule: 'write_scope', subject: node.runtime.paths().root, scope: 'session' })
  let out = ''; let err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { out += String(chunk); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { err += String(chunk); return true })
  expect((await runCli({ argv: ['workspace', 'set', 'history.maxFileBytes', '1'], config: node.config, confirm: null })).exitCode).toBe(0)
  out = ''; err = ''
  const result = await runCli({ argv: ['call', 'fs_write', '--json', JSON.stringify({ path: 'cli.txt', content: 'hello' })], config: node.config, confirm: null })
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(out)).toBeTruthy()
  expect(err).toMatch(/history.*(restore|restorable)/i)
})

it('copy prints a successful PUT history notice on stderr', async () => {
  const node = await workspace(false)
  const file = join(node.path, 'source.txt'); writeFileSync(file, 'hello')
  const server = createServer((request, response) => { request.resume(); request.on('end', () => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ requestId: 'copy', outcome: 'ok', output: {}, meta: { durationMs: 1, truncated: false, history: { checkpoint: 'change-fixture', restorable: false, reason: 'Host git unavailable' } } })) }) })
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address')
  let out = ''; let err = ''
  const result = await copyCommand([file, 'site:copy.txt', '--node', `http://127.0.0.1:${address.port}`], { BUCKLE_AUTH_TOKEN: 'fixture' }, { stdout: { write: text => { out += text } }, stderr: { write: text => { err += text } } })
  expect(result.exitCode).toBe(0)
  expect(out).toMatch(/^Copied /)
  expect(err).toMatch(/history.*(restore|restorable)/i)
})

it('copy accepts an older successful answer without metadata', async () => {
  const node = await workspace(false)
  const file = join(node.path, 'source.txt'); writeFileSync(file, 'hello')
  const server = createServer((request, response) => { request.resume(); request.on('end', () => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ requestId: 'copy', outcome: 'ok', output: {} })) }) })
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address')
  let err = ''
  const result = await copyCommand([file, 'site:copy.txt', '--node', `http://127.0.0.1:${address.port}`], { BUCKLE_AUTH_TOKEN: 'fixture' }, { stdout: { write: () => {} }, stderr: { write: text => { err += text } } })
  expect(result.exitCode).toBe(0)
  expect(err).toBe('')
})
