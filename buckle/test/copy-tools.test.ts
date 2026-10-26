import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvokeResponse, JsonObject } from '@5straps/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyWorkspacePolicy } from '@5straps/protocol'
import { describeCall } from '../common/domain/describe-call.js'
import { createPathView } from '../common/domain/path-view.js'
import type { FileChannel, IncomingFile, OutgoingFile } from '../common/domain/tool.js'
import { MAX_TRANSFER_BYTES } from '../common/services/packs/browser/file-transfer.js'
import { refuseLanding } from '../common/services/packs/fs/transfer.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { configFromEnvironment } from './support/workspace-config.js'

// `buckle cp` on the node (the copy-verb brief): fs_receive and fs_send are judged, approved, and audited as fs_write and
// fs_read are, run with the bytes beside the call and never in its arguments, and offered to no agent, MCP client, or script.

const roots: string[] = []
const runtimes: BuckleRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function node(extra: Record<string, string> = {}): Promise<{ root: string; workspace: string; state: string; runtime: BuckleRuntime }> {
  const root = mkdtempSync(join(tmpdir(), 'buckle-copy-tools-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const state = join(root, 'state')
  mkdirSync(workspace)
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: state, BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '1', ...extra })
  const runtime = await createRuntime({ config })
  runtimes.push(runtime)
  return { root, workspace, state, runtime }
}

/** Writes anywhere in the folder go ahead for the session the copies run in, as a person's session grant would let them. */
async function grantWrites(runtime: BuckleRuntime, folder: string): Promise<void> {
  await runtime.grants.grant({ sessionId: 'copy', rule: 'write_scope', subject: folder, scope: 'session' })
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** A body that hands its chunks over as they are read, and counts how many were read, so a test sees whether any was. */
function body(chunks: Uint8Array[], options: { failAfter?: number } = {}): { file: IncomingFile; pulled: () => number } {
  let pulled = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (options.failAfter !== undefined && pulled >= options.failAfter) { controller.error(new Error('The caller left')); return }
      const next = chunks[pulled++]
      if (next === undefined) controller.close()
      else controller.enqueue(next)
    },
  }, { highWaterMark: 0 })
  return { file: { kind: 'receive', body: stream }, pulled: () => pulled }
}

/** Where fs_send's chunks go: collected, after `before` runs once the file is hashed and before its first chunk is read. */
function collector(before?: () => void): { file: OutgoingFile; sent: () => { size: number; sha256: string; bytes: Buffer } | undefined } {
  let sent: { size: number; sha256: string; bytes: Buffer } | undefined
  return {
    file: {
      kind: 'send',
      async send(file) {
        before?.()
        const parts: Uint8Array[] = []
        for await (const chunk of file.chunks) parts.push(chunk)
        sent = { size: file.size, sha256: file.sha256, bytes: Buffer.concat(parts) }
      },
    },
    sent: () => sent,
  }
}

let sequence = 0
function call(runtime: BuckleRuntime, tool: string, args: JsonObject, file?: FileChannel, requestId = `copy-${++sequence}`): Promise<InvokeResponse> {
  return runtime.invoke({ request: { requestId, tool, args, approvalTokens: [] }, sessionId: 'copy', ...(file ? { file } : {}) })
}

const errorOf = (response: InvokeResponse) => (response.outcome === 'error' ? response.error : null)

/** Every entry in a folder, the hidden partial a copy writes into included. */
const entries = (folder: string) => readdirSync(folder).sort()

describe('fs_receive and fs_send are offered to no caller', () => {
  it('are left out of the manifest\'s tools, MCP\'s list, and buckle tools, and named in the fs pack and its limits', async () => {
    const { runtime } = await node()
    const listed = runtime.registry().capabilities().map(tool => tool.name)
    expect(listed).toContain('fs_write')
    expect(listed).not.toContain('fs_receive')
    expect(listed).not.toContain('fs_send')
    expect(runtime.manifest().tools.map(tool => tool.name)).not.toEqual(expect.arrayContaining(['fs_receive']))
    expect(runtime.manifest().packs.find(pack => pack.id === 'fs')?.toolNames).toEqual(expect.arrayContaining(['fs_receive', 'fs_send']))
    expect(runtime.manifest().limits.maxTransferBytes).toBe(MAX_TRANSFER_BYTES)
    expect(MAX_TRANSFER_BYTES).toBe(100 * 1_048_576)
  })

  it('takes the limit from BUCKLE_MAX_TRANSFER_BYTES', async () => {
    const { runtime } = await node({ BUCKLE_MAX_TRANSFER_BYTES: '4096' })
    expect(runtime.manifest().limits.maxTransferBytes).toBe(4096)
  })

  it('answers a call without the bytes as an unknown tool, and runs no other tool with them', async () => {
    const { runtime, workspace } = await node()
    await grantWrites(runtime, workspace)
    const content = Buffer.from('hello')
    const receive = await call(runtime, 'fs_receive', { path: 'a.txt', bytes: content.byteLength, sha256: sha256(content) })
    expect(errorOf(receive)).toEqual({ code: 'TOOL_NOT_FOUND', message: 'Tool is not available: fs_receive', retryable: false })
    expect(errorOf(await call(runtime, 'fs_send', { path: 'a.txt' }))?.code).toBe('TOOL_NOT_FOUND')
    const write = await call(runtime, 'fs_write', { path: 'b.txt', content: 'x' }, body([content]).file)
    expect(errorOf(write)?.code).toBe('TOOL_NOT_FOUND')
    expect(errorOf(await call(runtime, 'fs_send', { path: 'a.txt' }, body([content]).file))?.code).toBe('TOOL_NOT_FOUND')
    expect(entries(workspace)).toEqual([])
  })
})

describe('fs_receive', () => {
  it('lands the body whole once judged, and its result entry names the path, the bytes, and the digest', async () => {
    const { runtime, workspace } = await node()
    await grantWrites(runtime, workspace)
    const content = Buffer.from('a copied file\n'.repeat(1000))
    const sent = body([content.subarray(0, 5000), content.subarray(5000)])
    const response = await call(runtime, 'fs_receive', { path: 'out.txt', bytes: content.byteLength, sha256: sha256(content) }, sent.file)
    expect(response).toMatchObject({ outcome: 'ok', output: { path: 'out.txt', size: content.byteLength, sha256: sha256(content) } })
    expect(readFileSync(join(workspace, 'out.txt'))).toEqual(content)
    expect(entries(workspace)).toEqual(['out.txt'])
    const result = runtime.actions.read(5).find(entry => entry.tool === 'fs_receive' && entry.event === 'result')
    expect(result).toMatchObject({ outcome: 'ok', effects: ['write_path'], args: { path: 'out.txt', bytes: content.byteLength, sha256: sha256(content) } })
  })

  it('reads no byte before the call is judged: a write that asks answers approval_required with its body unread, and keeps nothing', async () => {
    const { runtime, workspace } = await node()
    const content = Buffer.from('waits for a person')
    const sent = body([content])
    const response = await call(runtime, 'fs_receive', { path: 'asked.txt', bytes: content.byteLength, sha256: sha256(content) }, sent.file)
    expect(response.outcome).toBe('approval_required')
    expect(sent.pulled()).toBe(0)
    expect(entries(workspace)).toEqual([])
  })

  it('shows the person the whole action, the bytes behind their count and digest (owner decisions D9 and D17)', async () => {
    const { runtime } = await node()
    const content = Buffer.from('shown')
    await call(runtime, 'fs_receive', { path: 'shown.txt', bytes: content.byteLength, sha256: sha256(content) }, body([content]).file)
    const ask = runtime.approvalService.waiting().find(item => item.request.tool === 'fs_receive')
    expect(ask?.call?.description).toBe(`Receive 5 bytes (sha256 ${sha256(content)}) into "shown.txt" in ${JSON.stringify(runtime.paths().displayRoot)}`)
    expect(ask?.call?.arguments).toEqual({ path: 'shown.txt', bytes: 5, sha256: sha256(content) })
    expect(ask?.call?.effects).toEqual([`write ${join(runtime.paths().root, 'shown.txt')}`])
  })

  it.each([
    ['a digest of other bytes', [Buffer.from('the wrong bytes')], { bytes: 15, sha256: sha256(Buffer.from('the right bytes')) }, 'TRANSFER_DIGEST_MISMATCH'],
    ['fewer bytes than declared', [Buffer.from('short')], { bytes: 10, sha256: sha256(Buffer.from('short')) }, 'TRANSFER_LENGTH_MISMATCH'],
    ['more bytes than declared', [Buffer.from('longer than said')], { bytes: 4, sha256: sha256(Buffer.from('long')) }, 'TRANSFER_LENGTH_MISMATCH'],
  ])('leaves nothing at the path or beside it for %s', async (_name, chunks, declared, code) => {
    const { runtime, workspace } = await node()
    await grantWrites(runtime, workspace)
    const response = await call(runtime, 'fs_receive', { path: 'kept.txt', ...declared }, body(chunks).file)
    expect(errorOf(response)?.code).toBe(code)
    expect(entries(workspace)).toEqual([])
  })

  it('leaves an existing file as it was, and nothing beside it, where the body is cut off mid-stream', async () => {
    const { runtime, workspace } = await node()
    await grantWrites(runtime, workspace)
    writeFileSync(join(workspace, 'kept.txt'), 'before')
    const content = Buffer.from('a body cut off after its first chunk')
    const response = await call(runtime, 'fs_receive', { path: 'kept.txt', bytes: content.byteLength, sha256: sha256(content) }, body([content.subarray(0, 8), content.subarray(8)], { failAfter: 1 }).file)
    expect(response.outcome).toBe('error')
    expect(readFileSync(join(workspace, 'kept.txt'), 'utf8')).toBe('before')
    expect(entries(workspace)).toEqual(['kept.txt'])
  })

  it('refuses a folder as the target before anyone is asked, and a target whose folder does not exist, naming it', async () => {
    const { runtime, workspace } = await node()
    mkdirSync(join(workspace, 'sub'))
    const content = Buffer.from('x')
    const folder = await call(runtime, 'fs_receive', { path: 'sub', bytes: 1, sha256: sha256(content) }, body([content]).file)
    expect(errorOf(folder)?.code).toBe('TARGET_IS_DIRECTORY')
    const missing = await call(runtime, 'fs_receive', { path: 'nope/deeper/x.txt', bytes: 1, sha256: sha256(content) }, body([content]).file)
    expect(errorOf(missing)).toMatchObject({ code: 'PARENT_MISSING', message: expect.stringContaining('The folder nope/deeper does not exist') })
    expect(runtime.approvalService.waiting()).toEqual([])
    expect(entries(workspace)).toEqual(['sub'])
  })

  it('reads a trailing separator as a folder: a missing one is named, a file is not replaced, and nothing is made or asked', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, 'notes.txt'), 'my notes')
    mkdirSync(join(workspace, 'sub'))
    const content = Buffer.from('x')
    const missing = await call(runtime, 'fs_receive', { path: 'releases/', bytes: 1, sha256: sha256(content) }, body([content]).file)
    expect(errorOf(missing)).toMatchObject({ code: 'PARENT_MISSING', message: expect.stringContaining('The folder releases does not exist') })
    const file = await call(runtime, 'fs_receive', { path: 'notes.txt/', bytes: 1, sha256: sha256(content) }, body([content]).file)
    expect(errorOf(file)).toMatchObject({ message: expect.stringContaining('notes.txt/ is a file, not a folder') })
    const folder = await call(runtime, 'fs_receive', { path: 'sub/', bytes: 1, sha256: sha256(content) }, body([content]).file)
    expect(errorOf(folder)?.code).toBe('TARGET_IS_DIRECTORY')
    expect(runtime.approvalService.waiting()).toEqual([])
    expect(readFileSync(join(workspace, 'notes.txt'), 'utf8')).toBe('my notes')
    expect(entries(workspace)).toEqual(['notes.txt', 'sub'])
  })

  it('reads a trailing backslash as a folder spelling on Windows alone, where it is a separator; elsewhere it ends a file name', async () => {
    const { workspace } = await node()
    const landing = join(workspace, 'report')
    const view = (platform: NodeJS.Platform) => createPathView({ root: workspace, mount: null, platform })
    // As settleReceive reaches it on Windows: the path was resolved without its trailing separator, which `named` still holds.
    expect(() => refuseLanding(landing, 'report\\', view('win32'), 'win32')).toThrow(/The folder report does not exist/)
    expect(() => refuseLanding(landing, 'report/', view('win32'), 'win32')).toThrow(/The folder report does not exist/)
    expect(() => refuseLanding(landing, 'report/', view('linux'), 'linux')).toThrow(/The folder report does not exist/)
    expect(() => refuseLanding(`${landing}\\`, 'report\\', view('linux'), 'linux')).not.toThrow()
    expect(() => refuseLanding(`${landing}\\`, 'report\\', view('darwin'), 'darwin')).not.toThrow()
  })

  it('answers TARGET_IS_DIRECTORY for a folder outside the workspace once the write is judged, so the copy can name the file in it', async () => {
    const { runtime, root } = await node()
    const outside = join(root, 'outside')
    mkdirSync(outside)
    await runtime.grants.grant({ sessionId: 'copy', rule: 'write_scope', subject: outside, scope: 'session' })
    const content = Buffer.from('into a folder')
    const sent = body([content])
    const response = await call(runtime, 'fs_receive', { path: outside, bytes: content.byteLength, sha256: sha256(content) }, sent.file)
    expect(errorOf(response)).toMatchObject({ code: 'TARGET_IS_DIRECTORY', message: expect.stringContaining('is a folder') })
    expect(sent.pulled()).toBe(0)
    expect(entries(outside)).toEqual([])
    const named = await call(runtime, 'fs_receive', { path: join(outside, 'file.txt'), bytes: content.byteLength, sha256: sha256(content) }, body([content]).file)
    expect(named.outcome).toBe('ok')
    expect(entries(outside)).toEqual(['file.txt'])
  })

  it('refuses a copy over the limit before anyone is asked or any byte is read', async () => {
    const { runtime, workspace } = await node({ BUCKLE_MAX_TRANSFER_BYTES: '8' })
    const sent = body([Buffer.from('nine byte')])
    const response = await call(runtime, 'fs_receive', { path: 'big.txt', bytes: 9, sha256: sha256(Buffer.from('nine byte')) }, sent.file)
    expect(errorOf(response)?.code).toBe('TRANSFER_TOO_LARGE')
    expect(sent.pulled()).toBe(0)
    expect(runtime.approvalService.waiting()).toEqual([])
    expect(entries(workspace)).toEqual([])
  })

  it('refuses Buckle\'s state as fs_write does, and a folder reached through a link to outside a mounted workspace', async () => {
    const { runtime, workspace, state, root } = await node({ BUCKLE_WORKSPACE_MOUNT: '/workspace' })
    await grantWrites(runtime, workspace)
    const content = Buffer.from('nope')
    const stateWrite = await call(runtime, 'fs_receive', { path: join(state, 'planted.txt'), bytes: 4, sha256: sha256(content) }, body([content]).file)
    expect(errorOf(stateWrite)?.code).toBe('PERMISSION_DENIED')
    mkdirSync(join(root, 'outside'))
    symlinkSync(join(root, 'outside'), join(workspace, 'link'))
    const linked = await call(runtime, 'fs_receive', { path: '/workspace/link/planted.txt', bytes: 4, sha256: sha256(content) }, body([content]).file)
    expect(errorOf(linked)?.code).toBe('PERMISSION_DENIED')
    expect(entries(join(root, 'outside'))).toEqual([])
  })
})

describe('fs_send', () => {
  it('hands on the file with its size and digest from one descriptor, and its result entry names them', async () => {
    const { runtime, workspace } = await node()
    const content = Buffer.alloc(2 * 1_048_576 + 17, 7)
    writeFileSync(join(workspace, 'big.bin'), content)
    const out = collector()
    const response = await call(runtime, 'fs_send', { path: 'big.bin' }, out.file)
    expect(response).toMatchObject({ outcome: 'ok', output: { path: 'big.bin', size: content.byteLength, sha256: sha256(content) } })
    expect(out.sent()).toEqual({ size: content.byteLength, sha256: sha256(content), bytes: content })
    const result = runtime.actions.read(5).find(entry => entry.tool === 'fs_send' && entry.event === 'result')
    expect(result).toMatchObject({ outcome: 'ok', effects: ['read_path'], args: { path: 'big.bin', bytes: content.byteLength, sha256: sha256(content) } })
  })

  it.each([
    ['grows', (file: string) => appendFileSync(file, 'more')],
    ['shrinks', (file: string) => writeFileSync(file, 'short')],
    ['changes in place', (file: string) => writeFileSync(file, Buffer.alloc(20, 9))],
  ])('cuts the response short where the file %s between its hash and its last byte', async (_name, change) => {
    const { runtime, workspace } = await node()
    const file = join(workspace, 'moving.bin')
    writeFileSync(file, Buffer.alloc(20, 1))
    const out = collector(() => change(file))
    const response = await call(runtime, 'fs_send', { path: 'moving.bin' }, out.file)
    expect(errorOf(response)?.code).toBe('TRANSFER_CHANGED')
    expect(out.sent()).toBeUndefined()
  })

  it('is judged as a read: a credential file asks, and the person is told its size', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, '.env'), 'KEY=value\n')
    const out = collector()
    const response = await call(runtime, 'fs_send', { path: '.env' }, out.file)
    expect(response.outcome).toBe('approval_required')
    expect(out.sent()).toBeUndefined()
    const ask = runtime.approvalService.waiting().find(item => item.request.tool === 'fs_send')
    expect(ask?.request.rule).toBe('sensitive_path')
    expect(ask?.call?.description).toBe(`Send ".env" (10 bytes) in ${JSON.stringify(runtime.paths().displayRoot)}`)
  })

  it('refuses a file over the limit, a folder, and a name with no file, sending nothing', async () => {
    const { runtime, workspace } = await node({ BUCKLE_MAX_TRANSFER_BYTES: '8' })
    writeFileSync(join(workspace, 'big.txt'), 'nine byte')
    mkdirSync(join(workspace, 'sub'))
    const out = collector()
    expect(errorOf(await call(runtime, 'fs_send', { path: 'big.txt' }, out.file))?.code).toBe('TRANSFER_TOO_LARGE')
    expect(errorOf(await call(runtime, 'fs_send', { path: 'sub' }, out.file))?.message).toContain('Not a regular file')
    expect(errorOf(await call(runtime, 'fs_send', { path: 'none.txt' }, out.file))).toEqual({ code: 'FILE_NOT_FOUND', message: 'There is no file at none.txt, so nothing was sent', retryable: false })
    expect(out.sent()).toBeUndefined()
  })
})

describe('the description of a copy', () => {
  it('names the bytes by count and digest, the path, and the folder, and fs_send\'s size where it was settled', () => {
    const digest = 'a'.repeat(64)
    expect(describeCall({ tool: 'fs_receive', args: { path: 'dist/app.tgz', bytes: 1, sha256: digest }, cwd: '/workspace' })).toBe(`Receive 1 byte (sha256 ${digest}) into "dist/app.tgz" in "/workspace"`)
    expect(describeCall({ tool: 'fs_send', args: { path: 'app.tgz' }, cwd: '/workspace', facts: { bytes: 2048 } })).toBe('Send "app.tgz" (2048 bytes) in "/workspace"')
    expect(describeCall({ tool: 'fs_send', args: { path: 'gone.tgz' }, cwd: '/workspace' })).toBe('Send "gone.tgz" in "/workspace"')
    // A digest that is no digest is quoted as any value the caller chose.
    expect(describeCall({ tool: 'fs_receive', args: { path: 'x', bytes: 1, sha256: 'not-hex' }, cwd: '/w' })).toBe('Receive 1 byte (sha256 "not-hex") into "x" in "/w"')
  })
})

describe('the tool policy and the two copy tools', () => {
  const denying = (...tools: string[]) => ({ ...emptyWorkspacePolicy(), tools: { deny: tools } })

  it('reads a denial of fs_write as a denial of fs_receive, and of fs_read as one of fs_send, so an upgrade opens no way round it', async () => {
    const { runtime, workspace } = await node()
    await grantWrites(runtime, workspace)
    writeFileSync(join(workspace, 'there.txt'), 'there')
    const content = Buffer.from('written')
    const receive = () => call(runtime, 'fs_receive', { path: 'in.txt', bytes: content.byteLength, sha256: sha256(content) }, body([content]).file)
    const send = () => call(runtime, 'fs_send', { path: 'there.txt' }, collector().file)
    await runtime.policy.apply(denying('fs_write'))
    expect(errorOf(await receive())).toMatchObject({ code: 'PERMISSION_DENIED' })
    expect((await send()).outcome).toBe('ok')
    await runtime.policy.apply(denying('fs_read'))
    expect(errorOf(await send())).toMatchObject({ code: 'PERMISSION_DENIED' })
    expect((await receive()).outcome).toBe('ok')
    expect(entries(workspace)).toEqual(['in.txt', 'there.txt'])
  })

  it('offers the transfer limit only while fs_receive is allowed', async () => {
    const { runtime } = await node()
    expect(runtime.manifest().limits.maxTransferBytes).toBe(MAX_TRANSFER_BYTES)
    await runtime.policy.apply(denying('fs_receive'))
    expect(runtime.manifest().limits.maxTransferBytes).toBeUndefined()
    await runtime.policy.apply(denying('fs_write'))
    expect(runtime.manifest().limits.maxTransferBytes).toBeUndefined()
    await runtime.policy.apply(emptyWorkspacePolicy())
    expect(runtime.manifest().limits.maxTransferBytes).toBe(MAX_TRANSFER_BYTES)
  })
})
