import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPathView } from '../common/domain/path-view.js'
import { prepareTransfer } from '../common/services/packs/browser/file-transfer.js'

// Re-check of 2026-10-14, round 2: delivery made its copy with the kernel's default mode (0644 under umask 022) and
// only then set a private target's 0600 on it, so another user could open the copy in between and read the new
// content through that descriptor. The copy is now created with the target's mode. Each fchmod here records the mode
// the file had at that moment, which is the mode it was created with.
const atChmod = vi.hoisted((): number[] => [])
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>()
  return { ...real, fchmodSync: (descriptor: number, mode: fs.Mode) => { atChmod.push(real.fstatSync(descriptor).mode & 0o777); real.fchmodSync(descriptor, mode) } }
})

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); atChmod.length = 0 })

describe('a delivery that replaces a private file', () => {
  it('is never more open than that file, from its creation on', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'buckle-delivery-mode-')))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const session = join(root, 'session')
    fs.mkdirSync(workspace)
    fs.mkdirSync(session, { mode: 0o700 })
    fs.writeFileSync(join(workspace, 'private.pdf'), 'old private content')
    fs.chmodSync(join(workspace, 'private.pdf'), 0o600)
    const transfer = await prepareTransfer({ directory: session, paths: createPathView({ root: workspace, mount: null }), reads: [], writes: ['private.pdf'], context: { signal: new AbortController().signal }, protectedRoots: [], staleAfterMs: 600_000 })
    fs.writeFileSync(transfer.argument('private.pdf')!, 'new private content')
    try { await transfer.deliver() } finally { transfer.close() }
    expect(atChmod).toEqual([0o600])
    expect(fs.statSync(join(workspace, 'private.pdf')).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(join(workspace, 'private.pdf'), 'utf8')).toBe('new private content')
  })
})
