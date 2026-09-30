import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsonObject } from '@5straps/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { createPathView } from '../common/domain/path-view.js'
import { createBrowserPack, type BrowserPackOptions } from '../common/services/packs/browser/index.js'
import { MAX_TRANSFER_BYTES, prepareTransfer } from '../common/services/packs/browser/file-transfer.js'
import type { ProcessRequest, ProcessResult } from '../common/types/ports/process-runner.js'

// Review L4 of the second proof-of-possession re-review: browser transfer copies were synchronous and
// unbounded (512 MiB staged in full blocked the node), the call's timeout could not stop one, and a node
// killed mid-call left its transfer directory in Buckle's state.

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'buckle-transfer-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const session = join(root, 'session')
  mkdirSync(workspace)
  mkdirSync(session, { mode: 0o700 })
  return { root, workspace, session, paths: createPathView({ root: workspace, mount: null }) }
}

const transfers = (session: string) => readdirSync(session).filter(name => name.startsWith('transfer-'))

async function browser(input: { workspace: string; session: string; args: JsonObject; run?: (request: ProcessRequest) => void; options?: Partial<BrowserPackOptions> }) {
  const pack = createBrowserPack({
    cwd: input.workspace, paths: createPathView({ root: input.workspace, mount: null }), agentBrowserCommand: 'agent-browser', sessionDirectory: input.session,
    headed: false, available: true, approvedLists: [],
    runProcess: async (request): Promise<ProcessResult> => {
      input.run?.(request)
      return { exitCode: 0, signal: null, stdout: '{"success":true}', stderr: '', truncated: false, timedOut: false }
    },
    ...input.options,
  })
  return pack.tools[0]!.prepare(input.args).execute({ requestId: 'r1', sessionId: 's1', timeoutMs: 1_000, signal: new AbortController().signal })
}

describe('a browser file transfer', () => {
  it('refuses an upload larger than the cap, naming it, and stages nothing', async () => {
    const { workspace, session } = fixture()
    writeFileSync(join(workspace, 'big.bin'), '')
    truncateSync(join(workspace, 'big.bin'), MAX_TRANSFER_BYTES + 1)
    let ran = false
    await expect(browser({ workspace, session, args: { command: 'upload', args: ['#file', 'big.bin'] }, run: () => { ran = true } })).rejects.toThrow('big.bin is larger than the 100 MiB a browser command transfers')
    expect(ran).toBe(false)
    expect(transfers(session)).toEqual([])
  })

  it('refuses to deliver a screenshot larger than the cap, and writes nothing to its target', async () => {
    const { workspace, session } = fixture()
    const run = (request: ProcessRequest) => {
      const staged = request.args[1]!
      writeFileSync(staged, '')
      truncateSync(staged, MAX_TRANSFER_BYTES + 1)
    }
    await expect(browser({ workspace, session, args: { command: 'screenshot', args: ['shot.png'] }, run })).rejects.toThrow('shot.png is larger than the 100 MiB')
    expect(existsSync(join(workspace, 'shot.png'))).toBe(false)
    expect(transfers(session)).toEqual([])
  })

  it('stops a copy when the call\'s signal fires, and leaves no transfer directory', async () => {
    const { workspace, session, paths } = fixture()
    writeFileSync(join(workspace, 'large.bin'), '')
    truncateSync(join(workspace, 'large.bin'), 64 * 1_048_576)
    const stop = new AbortController()
    setImmediate(() => stop.abort(new Error('the call timed out')))
    await expect(prepareTransfer({ directory: session, paths, reads: ['large.bin'], writes: [], context: { signal: stop.signal }, protectedRoots: [] })).rejects.toThrow('the call timed out')
    expect(transfers(session)).toEqual([])
  })

  it('sweeps transfer directories a stopped node left at pack start, and keeps one a call may still use', async () => {
    const { workspace, session } = fixture()
    for (const name of ['transfer-stale', 'transfer-live']) mkdirSync(join(session, name, '0'), { recursive: true })
    writeFileSync(join(session, 'transfer-stale', '0', 'upload.png'), 'left behind')
    const old = (Date.now() - 2 * 60_000 - 1_000) / 1_000
    utimesSync(join(session, 'transfer-stale'), old, old)
    await browser({ workspace, session, args: { command: 'snapshot' }, options: { maxTimeoutMs: 60_000 } })
    expect(transfers(session)).toEqual(['transfer-live'])
  })
})
