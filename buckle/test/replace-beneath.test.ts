import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openRealDirectory } from '../common/adapters/beneath.js'
import { replaceBeneath } from '../common/adapters/replace-beneath.js'
import type { RenameIo } from '../common/adapters/replace-file.js'

// On Windows a rename over a file another program holds open fails with EPERM or EBUSY. replaceBeneath, which fs_receive and
// the browser's downloads land through, tries it again as the state files do, and says the target is held where it stays so.

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const held = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })

async function replace(folder: string, io: RenameIo): Promise<void> {
  const directory = openRealDirectory(folder)
  try {
    await replaceBeneath({ directory, name: 'target.txt', named: 'target.txt', signal: new AbortController().signal, io, fill: async () => { /* The new file stays empty, which the target's content then is. */ } })
  } finally { directory.close() }
}

describe('replaceBeneath where the target is held open', () => {
  it('tries the rename again, a pause longer each time, and replaces the target once it is free', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'replace-beneath-'))
    roots.push(folder)
    writeFileSync(join(folder, 'target.txt'), 'old')
    const pauses: number[] = []
    let attempts = 0
    await replace(folder, { rename: (from, to) => { if (++attempts < 3) throw held(); renameSync(from, to) }, pause: async (ms) => { pauses.push(ms) } })
    expect(readFileSync(join(folder, 'target.txt'), 'utf8')).toBe('')
    expect(pauses).toEqual([20, 40])
    expect(readdirSync(folder)).toEqual(['target.txt'])
  })

  it('refuses in words that say the target is held, leaves it as it was, and removes the new file', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'replace-beneath-'))
    roots.push(folder)
    writeFileSync(join(folder, 'target.txt'), 'old')
    await expect(replace(folder, { rename: () => { throw held() }, pause: async () => {} })).rejects.toMatchObject({ message: 'target.txt is held open by another program, so it was not replaced; close it and send the call again', code: 'ENTRY_HELD' })
    expect(readFileSync(join(folder, 'target.txt'), 'utf8')).toBe('old')
    expect(readdirSync(folder)).toEqual(['target.txt'])
  })
})
