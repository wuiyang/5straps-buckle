import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvokeResponse } from '@5straps/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { FILES_HOLD_MS, filesWait, outgoingFile } from '../layers/common/server/utils/files.js'
import { configFromEnvironment } from './support/workspace-config.js'

// GET /v1/files hands fs_send a channel (outgoingFile) whose stream the response is: it pulls a chunk as the caller
// reads one, errors rather than ends where the file changed after its hash, and fails the send where the caller left.

const roots: string[] = []
const runtimes: BuckleRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function node(extra: Record<string, string> = {}): Promise<{ workspace: string; runtime: BuckleRuntime }> {
  const root = mkdtempSync(join(tmpdir(), 'buckle-copy-stream-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '1', ...extra })
  const runtime = await createRuntime({ config })
  runtimes.push(runtime)
  return { workspace, runtime }
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const errorOf = (response: InvokeResponse) => (response.outcome === 'error' ? response.error : null)

let sequence = 0
function call(runtime: BuckleRuntime, path: string, file: ReturnType<typeof outgoingFile>['channel']): Promise<InvokeResponse> {
  return runtime.invoke({ request: { requestId: `stream-${++sequence}`, tool: 'fs_send', args: { path }, approvalTokens: [] }, sessionId: 'copy', file })
}

describe('the response stream of GET /v1/files', () => {
  it('errors the route\'s response stream, never ends it, where the file grows after its first chunks went out', async () => {
    const { runtime, workspace } = await node()
    const file = join(workspace, 'moving.bin')
    writeFileSync(file, Buffer.alloc(3 * 1_048_576, 1))
    const outgoing = outgoingFile()
    const running = call(runtime, 'moving.bin', outgoing.channel)
    const ready = await outgoing.ready
    expect(ready).toMatchObject({ size: 3 * 1_048_576, sha256: sha256(Buffer.alloc(3 * 1_048_576, 1)) })
    const reader = ready.stream.getReader()
    expect((await reader.read()).done).toBe(false)
    appendFileSync(file, 'more')
    const drained = (async () => { for (;;) if ((await reader.read()).done) return 'ended' })()
    await expect(drained).rejects.toMatchObject({ code: 'TRANSFER_CHANGED' })
    expect(errorOf(await running)?.code).toBe('TRANSFER_CHANGED')
  })

  it('ends the call as the caller leaves: a cancelled response stream fails the send', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, 'left.bin'), Buffer.alloc(3 * 1_048_576, 2))
    const outgoing = outgoingFile()
    const running = call(runtime, 'left.bin', outgoing.channel)
    const reader = (await outgoing.ready).stream.getReader()
    await reader.read()
    await reader.cancel()
    expect((await running).outcome).toBe('error')
  })

  it('ends the call at its timeout, and errors the response stream, where the caller holds the connection and reads no more', async () => {
    const { runtime, workspace } = await node({ BUCKLE_MAX_TIMEOUT_MS: '300' })
    writeFileSync(join(workspace, 'stalled.bin'), Buffer.alloc(3 * 1_048_576, 3))
    const outgoing = outgoingFile()
    const running = call(runtime, 'stalled.bin', outgoing.channel)
    const reader = (await outgoing.ready).stream.getReader()
    await reader.read()
    // The caller reads nothing more and does not leave: only the call's own timeout can end it.
    const ended = await Promise.race([running, new Promise<'still running'>(resolve => setTimeout(() => resolve('still running'), 5_000))])
    expect(ended).not.toBe('still running')
    expect((ended as InvokeResponse).outcome).toBe('error')
    await expect(reader.read()).rejects.toBeDefined()
    expect(await runtime.hasActiveWork()).toBe(false)
  })
})

describe('the wait a copy is held for a person', () => {
  it('is the workspace\'s own, at most two minutes, so a held PUT and its upload fit the 300 seconds node:http gives a request', () => {
    expect(FILES_HOLD_MS).toBe(120_000)
    expect(filesWait(15_000)).toEqual({ mode: 'finite', ms: 15_000 })
    expect(filesWait(1)).toEqual({ mode: 'finite', ms: 1 })
    expect(filesWait(null)).toEqual({ mode: 'finite', ms: FILES_HOLD_MS })
    expect(filesWait(600_000)).toEqual({ mode: 'finite', ms: FILES_HOLD_MS })
  })
})
