import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InvokeResponseSchema, type InvokeResponse } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configFromEnvironment } from './support/workspace-config.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import type { BuckleConfig } from '../common/runtime/config.js'
import { fixedInteraction } from './support/interaction.js'
import { createMcpHttpHandlers } from '../mcp/http.js'
import { MCP_HOLD_MS, mcpWait } from '../mcp/holds.js'
import { sameCallKey } from '../mcp/resend-join.js'

// The MCP asks brief, items 1 to 3, over the HTTP face's own handler (mcp/http.ts) with a real workspace runtime: the
// hold is capped, an unanswered hold answers structurally and is no error, an identical re-send joins the call that
// asked, so it never runs twice for one decision, and the `_meta` hints shorten the wait and name the requestId.

const PROTOCOL = '2026-07-28'
const handlers = createMcpHttpHandlers()
const opened: BuckleRuntime[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const runtime of opened.splice(0)) {
    await runtime.approvalService.close()
    await runtime.history.close()
  }
})

async function node(wait: string) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-mcp-asks-'))
  for (const directory of ['workspace', 'outside']) mkdirSync(join(root, directory))
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: wait })
  const runtime = await createRuntime({ config, interaction: fixedInteraction() })
  opened.push(runtime)
  return { root, config, runtime }
}

interface ToolResult { isError?: boolean; content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> }

/** One tools/call over the face, as an MCP client sends it, and the tool result it answers. */
async function call(workspace: { config: BuckleConfig; runtime: BuckleRuntime }, input: { tool: string; args: Record<string, unknown>; meta?: Record<string, unknown>; signal?: AbortSignal }): Promise<ToolResult> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: input.tool, arguments: input.args, _meta: { 'io.modelcontextprotocol/protocolVersion': PROTOCOL, 'io.modelcontextprotocol/clientCapabilities': {}, ...input.meta } } })
  const request = new Request('http://127.0.0.1/mcp', {
    method: 'POST', body, ...(input.signal ? { signal: input.signal } : {}),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL, 'mcp-method': 'tools/call', 'mcp-name': input.tool },
  })
  const response = await handlers.fetch(workspace, request)
  const text = await response.text()
  const json = response.headers.get('content-type')?.includes('text/event-stream')
    ? text.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)) as { result?: ToolResult }).find(message => message.result)
    : JSON.parse(text) as { result?: ToolResult }
  if (!json?.result) throw new Error(`No tool result in ${text}`)
  return json.result
}

const writeOutside = (root: string, name = 'note.md') => ({ tool: 'fs_write', args: { path: join(root, 'outside', name), content: 'from the agent' } })

function results(runtime: BuckleRuntime, tool = 'fs_write') {
  return runtime.actions.read(200).filter(entry => entry.event === 'result' && entry.tool === tool)
}

async function approve(runtime: BuckleRuntime, scope: 'once' | 'session' = 'once') {
  const [token] = runtime.approvalService.pending().map(request => request.token)
  expect((await runtime.approvalService.answer({ decision: { token: token!, approved: true, scope }, authority: 'admin' })).ok).toBe(true)
}

describe('the HTTP MCP face\'s hold (item 1)', () => {
  it(`holds a call for the workspace's wait, at most ${MCP_HOLD_MS} ms, and reads 0 as that cap`, () => {
    expect(MCP_HOLD_MS).toBe(30_000)
    expect(mcpWait(15_000)).toEqual({ mode: 'finite', ms: 15_000 })
    expect(mcpWait(null)).toEqual({ mode: 'finite', ms: MCP_HOLD_MS })
    expect(mcpWait(600_000)).toEqual({ mode: 'finite', ms: MCP_HOLD_MS })
  })

  it.each([['0', MCP_HOLD_MS], ['600000', MCP_HOLD_MS], ['15000', 15_000]] as const)('gives a call at workspace wait %s a hold of %i ms', async (wait, held) => {
    const workspace = await node(wait)
    const invoke = vi.spyOn(workspace.runtime, 'invoke').mockResolvedValue({ requestId: 'r', outcome: 'ok', output: null, meta: { durationMs: 0, truncated: false } })
    await call(workspace, writeOutside(workspace.root))
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ approvalWait: { mode: 'finite', ms: held } }))
  })

  it('answers an unanswered hold as no error, with the prose and /v1/invoke\'s own approval_required answer', async () => {
    const workspace = await node('50')
    const result = await call(workspace, writeOutside(workspace.root))

    expect(result.isError).toBe(false)
    expect(result.content[0]!.text).toContain('This call needs approval')
    expect(result.content[0]!.text).toContain('Once it is decided, send this same call again: it joins this ask')
    expect(result.content[0]!.text).not.toContain('Then retry')
    const answer = InvokeResponseSchema.parse(result.structuredContent) as Extract<InvokeResponse, { outcome: 'approval_required' }>
    expect(answer).toMatchObject({ outcome: 'approval_required', requestId: expect.any(String) })
    expect(answer.approvals.map(approval => approval.token)).toEqual(workspace.runtime.approvalService.pending().map(request => request.token))
  })
})

describe('an identical re-send (item 2)', () => {
  it('reuses the requestId of the call that asked, joins its ask, and runs once when approved', async () => {
    const workspace = await node('50')
    const first = await call(workspace, writeOutside(workspace.root))
    const again = await call(workspace, writeOutside(workspace.root))

    expect(again.structuredContent?.['requestId']).toBe(first.structuredContent?.['requestId'])
    expect(workspace.runtime.approvalService.pending()).toHaveLength(1)
    await approve(workspace.runtime)
    const ran = await call(workspace, writeOutside(workspace.root))

    expect(ran.isError).toBeUndefined()
    expect(readFileSync(join(workspace.root, 'outside', 'note.md'), 'utf8')).toBe('from the agent')
    expect(results(workspace.runtime).filter(entry => entry.outcome === 'ok')).toHaveLength(1)
  })

  it('carries a wait on from a call still held, which ends without running, and runs once', async () => {
    const workspace = await node('60000')
    const held = call(workspace, writeOutside(workspace.root))
    await vi.waitFor(() => expect(workspace.runtime.approvalService.pending()).toHaveLength(1))
    const again = call(workspace, writeOutside(workspace.root))

    expect((await held).content[0]!.text).toContain('REQUEST_SUPERSEDED')
    await approve(workspace.runtime)
    expect((await again).isError).toBeUndefined()
    expect(results(workspace.runtime).filter(entry => entry.outcome === 'ok')).toHaveLength(1)
  })

  it('runs once after a client that closed its connection sends the call again, once approved', async () => {
    const workspace = await node('60000')
    const leaving = new AbortController()
    const held = call(workspace, { ...writeOutside(workspace.root), signal: leaving.signal }).catch((error: unknown) => error)
    await vi.waitFor(() => expect(workspace.runtime.approvalService.pending()).toHaveLength(1))
    leaving.abort()
    await held
    await vi.waitFor(() => expect(results(workspace.runtime)).toContainEqual(expect.objectContaining({ detail: 'CALLER_LEFT' })))
    expect(existsSync(join(workspace.root, 'outside', 'note.md'))).toBe(false)

    await approve(workspace.runtime)
    expect((await call(workspace, writeOutside(workspace.root))).isError).toBeUndefined()
    expect(workspace.runtime.approvalService.pending()).toEqual([])
    expect(results(workspace.runtime).filter(entry => entry.outcome === 'ok')).toHaveLength(1)
  })

  it('replays a run that answered later than the hold cap, as its client may have stopped reading, and never runs it again', async () => {
    const workspace = await node('60000')
    vi.useFakeTimers({ toFake: ['performance'] })
    const held = call(workspace, writeOutside(workspace.root))
    await vi.waitFor(() => expect(workspace.runtime.approvalService.pending()).toHaveLength(1))
    vi.advanceTimersByTime(MCP_HOLD_MS + 1_000)
    await approve(workspace.runtime)
    expect((await held).isError).toBeUndefined()

    const again = await call(workspace, writeOutside(workspace.root))
    expect(again.isError).toBeUndefined()
    expect(results(workspace.runtime).map(entry => entry.detail)).toEqual([undefined, 'REPLAYED'])
  })

  it('forgets a call whose outcome its client read in time: the next identical call is a call of its own', async () => {
    const workspace = await node('60000')
    const held = call(workspace, writeOutside(workspace.root))
    await vi.waitFor(() => expect(workspace.runtime.approvalService.pending()).toHaveLength(1))
    await approve(workspace.runtime)
    expect((await held).isError).toBeUndefined()

    // The approval was once, so the same write asks again, under a requestId of its own.
    workspace.config.approvalTimeoutMs = 50
    const next = await call(workspace, writeOutside(workspace.root))
    expect(next.structuredContent).toMatchObject({ outcome: 'approval_required' })
    expect(results(workspace.runtime).map(entry => entry.detail)).not.toContain('REPLAYED')
  })

  it('counts as identical the same tool and arguments, keys in any order, from the same session and actor, and nothing else', () => {
    const base = { sessionId: 'mcp', actor: 'agent', tool: 'fs_write', args: { path: 'a.md', content: 'x', options: { mode: 1, create: true } } }
    expect(sameCallKey({ ...base, args: { options: { create: true, mode: 1 }, content: 'x', path: 'a.md' } })).toBe(sameCallKey(base))
    for (const other of [
      { ...base, sessionId: 'mcp-2' },
      { ...base, actor: undefined },
      { ...base, tool: 'fs_patch' },
      { ...base, args: { ...base.args, content: 'x ' } },
      { ...base, args: { ...base.args, options: { mode: '1', create: true } } },
    ]) expect(sameCallKey(other)).not.toBe(sameCallKey(base))
  })
})

describe('the _meta hints (item 3)', () => {
  it('5straps/approvalWait shortens the hold', async () => {
    const workspace = await node('60000')
    const started = performance.now()
    const result = await call(workspace, { ...writeOutside(workspace.root), meta: { '5straps/approvalWait': 50 } })
    expect(result.structuredContent).toMatchObject({ outcome: 'approval_required' })
    expect(performance.now() - started).toBeLessThan(10_000)
  })

  it('5straps/approvalWait never lengthens the hold past the face\'s own, and 0 answers at once', async () => {
    const workspace = await node('15000')
    const invoke = vi.spyOn(workspace.runtime, 'invoke').mockResolvedValue({ requestId: 'r', outcome: 'ok', output: null, meta: { durationMs: 0, truncated: false } })
    await call(workspace, { ...writeOutside(workspace.root), meta: { '5straps/approvalWait': 120_000 } })
    await call(workspace, { ...writeOutside(workspace.root), meta: { '5straps/approvalWait': 0 } })
    expect(invoke.mock.calls.map(([input]) => input.approvalWait)).toEqual([{ mode: 'finite', ms: 15_000 }, { mode: 'none' }])
  })

  it('5straps/requestId names the call exactly: the answer carries it, and a re-send under it joins the ask', async () => {
    const workspace = await node('50')
    const requestId = '0f8b4c52-7a1d-4e3b-9c55-2d6e8f1a3b70'
    const first = await call(workspace, { ...writeOutside(workspace.root), meta: { '5straps/requestId': requestId } })
    expect(first.structuredContent).toMatchObject({ outcome: 'approval_required', requestId })
    const again = await call(workspace, { ...writeOutside(workspace.root), meta: { '5straps/requestId': requestId } })
    expect(again.structuredContent).toMatchObject({ requestId })
    expect(workspace.runtime.approvalService.pending()).toHaveLength(1)
  })

  it.each([
    ['5straps/requestId', 'not-a-uuid'],
    ['5straps/requestId', 42],
    ['5straps/approvalWait', -1],
    ['5straps/approvalWait', 1.5],
    ['5straps/approvalWait', '1000'],
  ])('refuses %s of %j with a clear error, before anything is asked', async (hint, value) => {
    const workspace = await node('50')
    const result = await call(workspace, { ...writeOutside(workspace.root), meta: { [hint]: value } })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain(`INVALID_HINT: ${hint} takes`)
    expect(workspace.runtime.approvalService.pending()).toEqual([])
  })
})
