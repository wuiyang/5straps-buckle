import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerContext } from '@modelcontextprotocol/server'
import type { InvokeResponse } from '@5straps/protocol'
import { z } from 'zod'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createToolRegistry } from '../common/domain/tool-registry.js'
import { grantsPath, type BuckleConfig } from '../common/runtime/config.js'
import { initializeCommon, type BuckleCommon, type RuntimeRole } from '../common/runtime/initialize.js'
import { HTTP_MCP_SESSION, SERVE_SESSION, stdioSession } from '../common/services/workspaces/face-session.js'
import { bindFormsOpener } from '../common/services/workspaces/forms-opener.js'
import { createRuntime, type BuckleRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { SOURCES } from '../common/types/ports/approval-source.js'
import { createStdioServer } from '../mcp/stdio.js'
import { auditEntries, settleAuditLogs } from './support/action-log-writer.js'
import { fixedInteraction } from './support/interaction.js'
import { configFromEnvironment, nodeConfigOf } from './support/workspace-config.js'
import { coreOf, defaultRuntime } from './support/workspaces.js'

// The faces' own sessions: each stdio MCP process holds one of its own, which ends as it exits, and HTTP MCP, served
// stateless, holds `mcp`, which ends as `buckle serve` stops and as it opens a workspace again, as after a crash.

const roots: string[] = []
const commons: BuckleCommon[] = []
afterEach(async () => {
  for (const common of commons.splice(0)) await common.owner.close()
  await settleAuditLogs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function node(): BuckleConfig {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-face-sessions-')))
  roots.push(root)
  for (const folder of ['one', 'three']) mkdirSync(join(root, 'workspace', folder), { recursive: true })
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  return configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs' })
}

/** A Buckle process of `role` on the node, started, with its workspace open. */
async function started(config: BuckleConfig, role: RuntimeRole): Promise<{ common: BuckleCommon; runtime: CoreRuntime }> {
  const common = initializeCommon({ config: nodeConfigOf(config), role })
  commons.push(common)
  await common.start()
  return { common, runtime: await defaultRuntime(common) }
}

let sequence = 0
function write(runtime: CoreRuntime, sessionId: string, path: string): Promise<InvokeResponse> {
  return runtime.invoke({ sessionId, approvalWait: { mode: 'none' }, request: { requestId: `write-${++sequence}`, tool: 'fs_write', args: { path, content: 'x' }, approvalTokens: [] } })
}

/** A first write to `path`'s folder, which asks, approved for its session, so the next write there runs without asking. */
async function approvedForSession(runtime: CoreRuntime, sessionId: string, path: string): Promise<void> {
  const asking = await write(runtime, sessionId, path)
  expect(asking).toMatchObject({ outcome: 'approval_required' })
  const token = asking.outcome === 'approval_required' ? asking.approvals[0]!.token : ''
  expect(await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'session' }, source: SOURCES.cli })).toMatchObject({ ok: true })
  expect(await write(runtime, sessionId, path)).toMatchObject({ outcome: 'ok' })
}

async function closed(runtime: CoreRuntime): Promise<void> {
  runtime.closeWatchers()
  await runtime.approvalService.close()
  await runtime.history.close()
}

const sessionEnds = async (runtime: CoreRuntime) => (await auditEntries(runtime.actions, 200)).filter(entry => entry.tool === 'approval_session_ended').map(entry => ({ sessionId: entry.sessionId, args: entry.args }))
const sessionsOf = (runtime: CoreRuntime) => runtime.grants.list().map(grant => grant.sessionId).sort()
const tally = (cause: string, counts: { withdrawn?: number; grants?: number }) => ({ cause, withdrawn: counts.withdrawn ?? 0, onces: 0, owed: 0, grants: counts.grants ?? 0, denials: 0 })

/** A stdio MCP server over a runtime that answers every call at once, with the session each call and its scope were given. */
function stdioServer(sessionId: string) {
  const registry = createToolRegistry([{
    capability: { name: 'any_tool', description: 'Answers at once', inputSchema: { type: 'object', properties: {} }, risk: 'read', tags: [], pack: 'test' },
    inputSchema: z.object({}),
    prepare: () => ({ effects: [], execute: async () => null }),
  }])
  const invoke = vi.fn(async (_input: { sessionId: string }) => ({ requestId: 'r', outcome: 'ok' as const, output: null, meta: { durationMs: 0, truncated: false } }))
  const runtime = { registry: () => registry, manifest: () => ({ tools: registry.capabilities(), version: '0.0.0' }), skills: () => [], onToolsChanged: () => undefined, approvalForms: () => false, invoke } as unknown as BuckleRuntime
  bindFormsOpener(runtime, () => undefined)
  const scopes: string[] = []
  const server = createStdioServer({ runtime, sessionId, config: { serverName: 'stdio-test', serverId: 'node-1', approvalTimeoutMs: 1_000 }, callScope: (run, context) => { scopes.push(context.sessionId); return run() }, beforeCall: async () => undefined })
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown, context: ServerContext) => Promise<unknown> }> })._registeredTools
  const context = { mcpReq: { id: 1, method: 'tools/call', requestState: () => undefined } } as unknown as ServerContext
  return { invoke, scopes, call: () => tools['any_tool']!.handler({}, context) }
}

describe('a stdio MCP process\'s session', () => {
  it('is its own, minted as the process starts, and names each call it serves and that call\'s scope', async () => {
    const first = stdioSession()
    const second = stdioSession()
    expect(first.sessionId).toMatch(/^stdio:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(second.sessionId).not.toBe(first.sessionId)

    const served = stdioServer(first.sessionId)
    await served.call()
    expect(served.invoke).toHaveBeenCalledWith(expect.objectContaining({ sessionId: first.sessionId }))
    expect(served.scopes).toEqual([first.sessionId])
  })

  it('differs between two stdio processes, and one exiting ends its own session alone, withdrawing its asks', async () => {
    const config = node()
    const one = await started(config, 'mcp')
    const oneSession = one.common.faceSession!.sessionId
    await approvedForSession(one.runtime, oneSession, 'one/a.md')
    expect(await write(one.runtime, oneSession, 'three/a.md')).toMatchObject({ outcome: 'approval_required' })

    // A stdio process ends nothing as it opens the workspace: the other's approval stays, and serves only the other.
    const two = await started(config, 'mcp')
    const twoSession = two.common.faceSession!.sessionId
    expect(twoSession).toMatch(/^stdio:/)
    expect(twoSession).not.toBe(oneSession)
    await approvedForSession(two.runtime, twoSession, 'one/a.md')
    expect(await write(two.runtime, twoSession, 'three/b.md')).toMatchObject({ outcome: 'approval_required' })
    expect(sessionsOf(two.runtime)).toEqual([oneSession, twoSession].sort())

    await one.common.owner.close()

    expect(sessionsOf(two.runtime)).toEqual([twoSession])
    expect(two.runtime.approvalService.pending().map(request => request.subject)).toEqual([join(config.cwd, 'three')])
    expect(await write(two.runtime, twoSession, 'one/b.md')).toMatchObject({ outcome: 'ok' })
    expect(await sessionEnds(two.runtime)).toEqual([{ sessionId: oneSession, args: tally('stdio_closed', { withdrawn: 1, grants: 1 }) }])
  })
})

describe('the HTTP MCP session', () => {
  it('is mcp, which a CLI process neither holds nor ends', async () => {
    const config = node()
    const cli = await started(config, 'cli')
    expect(cli.common.faceSession).toBeUndefined()
    await approvedForSession(cli.runtime, HTTP_MCP_SESSION, 'one/a.md')
    await cli.common.owner.close()

    const after = await started(config, 'cli')
    expect(sessionsOf(after.runtime)).toEqual([HTTP_MCP_SESSION])
    expect(await sessionEnds(after.runtime)).toEqual([])
  })

  it('ends as serve starts after a crash: serve opening the workspace ends what the earlier serve left, and every other session stays', async () => {
    const config = node()
    // What a serve killed before its close step leaves on disk: an HTTP MCP approval and an ask still waiting. A CLI
    // process, which ends no face session, leaves the same.
    const crashed = await started(config, 'cli')
    await approvedForSession(crashed.runtime, HTTP_MCP_SESSION, 'one/a.md')
    await approvedForSession(crashed.runtime, 'rpc', 'one/a.md')
    expect(await write(crashed.runtime, HTTP_MCP_SESSION, 'three/a.md')).toMatchObject({ outcome: 'approval_required' })
    await crashed.common.owner.close()

    const serve = await started(config, 'server')
    expect(serve.common.faceSession?.sessionId).toBe(HTTP_MCP_SESSION)
    expect(sessionsOf(serve.runtime)).toEqual(['rpc'])
    expect(serve.runtime.approvalService.pending()).toEqual([])
    expect(await write(serve.runtime, HTTP_MCP_SESSION, 'one/b.md')).toMatchObject({ outcome: 'approval_required' })
    expect(await write(serve.runtime, 'rpc', 'one/b.md')).toMatchObject({ outcome: 'ok' })
    expect(await sessionEnds(serve.runtime)).toEqual([{ sessionId: HTTP_MCP_SESSION, args: tally('serve_started', { withdrawn: 1, grants: 1 }) }])
  })

  it('ends as serve opens a workspace taken offline and back online while it runs, and every other session stays', async () => {
    const config = node()
    const serve = await started(config, 'server')
    await approvedForSession(serve.runtime, HTTP_MCP_SESSION, 'one/a.md')
    await approvedForSession(serve.runtime, 'rpc', 'one/a.md')
    const workspaces = await serve.common.services.getWorkspaces()
    const id = serve.runtime.workspaceId
    await workspaces.update(id, { online: false })
    await workspaces.update(id, { online: true })

    const reopened = coreOf((await workspaces.resolve(id)).runtime)
    expect(sessionsOf(reopened)).toEqual(['rpc'])
    expect(await sessionEnds(reopened)).toEqual([{ sessionId: HTTP_MCP_SESSION, args: tally('serve_started', { grants: 1 }) }])
  })

  it('fails the open where the end at open cannot be made, so no call is served on what the earlier serve left', async () => {
    const config = node()
    mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 })
    writeFileSync(grantsPath(config), '{', { mode: 0o600 })
    const cli = await createRuntime({ config, interaction: fixedInteraction() })
    await closed(cli)
    await expect(createRuntime({ config, interaction: fixedInteraction(), faceSession: SERVE_SESSION })).rejects.toThrow('grants.json')

    writeFileSync(grantsPath(config), JSON.stringify({ version: 1, grants: [] }), { mode: 0o600 })
    const runtime = await createRuntime({ config, interaction: fixedInteraction(), faceSession: SERVE_SESSION })
    expect(runtime.grants.list()).toEqual([])
    await closed(runtime)
  })

  it('ends as serve stops, withdrawing its asks, and every other session stays', async () => {
    const config = node()
    const serve = await started(config, 'server')
    await approvedForSession(serve.runtime, HTTP_MCP_SESSION, 'one/a.md')
    await approvedForSession(serve.runtime, 'rpc', 'one/a.md')
    expect(await write(serve.runtime, HTTP_MCP_SESSION, 'three/a.md')).toMatchObject({ outcome: 'approval_required' })
    await serve.common.owner.close()

    const after = await started(config, 'cli')
    expect(sessionsOf(after.runtime)).toEqual(['rpc'])
    expect(after.runtime.approvalService.pending()).toEqual([])
    expect(await sessionEnds(after.runtime)).toEqual([{ sessionId: HTTP_MCP_SESSION, args: tally('serve_stopped', { withdrawn: 1, grants: 1 }) }])
  })
})
