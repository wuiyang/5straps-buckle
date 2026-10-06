import { closeSync, constants, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openHandleNoFollow, openNoFollow } from '../common/adapters/beneath.js'

// Windows has no O_NOFOLLOW, so Buckle checks a name with lstat before it opens it. Another process can swap a link in
// between. These tests imitate Windows through the platform each open takes, and swap the entry at a chosen lstat of
// the watched name: after the first answered (before the open), or before the second answers (after the open).
const race = vi.hoisted(() => ({ path: '', count: 0, after: new Map<number, () => void>(), before: new Map<number, () => void>() }))

function beforeLstat(path: unknown): void {
  if (path === race.path) race.before.get(race.count + 1)?.()
}

function afterLstat(path: unknown): void {
  if (path !== race.path) return
  race.count += 1
  race.after.get(race.count)?.()
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const lstatSync = ((path: string, options?: object) => {
    beforeLstat(path)
    const answer = actual.lstatSync(path, options)
    afterLstat(path)
    return answer
  }) as typeof actual.lstatSync
  return { ...actual, lstatSync, default: { ...actual, lstatSync } }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const lstat = (async (path: string, options?: object) => {
    beforeLstat(path)
    try { return await actual.lstat(path, options) } finally { afterLstat(path) }
  }) as typeof actual.lstat
  return { ...actual, lstat, default: { ...actual, lstat } }
})

const roots: string[] = []
afterEach(() => {
  race.path = ''
  resetRace()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A file the agent may write, a victim outside it holding text, and the swap that puts a link to the victim in its place. */
function scene(input: { exists: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-no-follow-'))
  roots.push(root)
  const victim = join(root, 'victim')
  writeFileSync(victim, 'victim')
  const path = join(root, 'target')
  if (input.exists) writeFileSync(path, 'target')
  race.path = path
  const swapInLink = () => { if (input.exists) unlinkSync(path); symlinkSync(victim, path) }
  return { path, victim, swapInLink }
}

const WRITE = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC

describe('the Windows open that follows no link, against a link swapped in after its check', () => {
  it('neither truncates nor opens a file through a link that replaced a checked file before the open', async () => {
    for (const open of [syncOpen, handleOpen]) {
      const { path, victim, swapInLink } = scene({ exists: true })
      race.after.set(1, swapInLink)
      await expect(open(path, WRITE)).rejects.toMatchObject({ code: 'ELOOP' })
      expect(readFileSync(victim, 'utf8')).toBe('victim')
      resetRace()
    }
  })

  it('neither creates nor truncates through a link that appeared where nothing was, and refuses it on the second check', async () => {
    for (const open of [syncOpen, handleOpen]) {
      const { path, victim, swapInLink } = scene({ exists: false })
      race.after.set(1, swapInLink)
      await expect(open(path, WRITE)).rejects.toMatchObject({ code: 'ELOOP' })
      expect(readFileSync(victim, 'utf8')).toBe('victim')
      expect(readlinkSync(path)).toBe(victim)
      resetRace()
    }
  })

  it('refuses, and truncates nothing, once a link replaced the file after the open', async () => {
    for (const open of [syncOpen, handleOpen]) {
      const { path, victim, swapInLink } = scene({ exists: true })
      race.before.set(2, swapInLink)
      await expect(open(path, WRITE)).rejects.toMatchObject({ code: 'ELOOP' })
      expect(readFileSync(victim, 'utf8')).toBe('victim')
      resetRace()
    }
  })

  // A read, an edit, or a write that names its expected hash opens without creating. Where lstat saw nothing, there is no
  // identity to compare what the open reached with, so a link swapped in and back out before the second check was
  // followed and its target read.
  it('reads nothing through a link that came and went where lstat saw no entry, and refuses one that does it again', async () => {
    for (const open of [syncRead, handleRead]) {
      const { path, swapInLink } = scene({ exists: false })
      race.after.set(1, swapInLink)
      race.before.set(2, () => unlinkSync(path))
      await expect(open(path)).rejects.toMatchObject({ code: 'ENOENT' })
      resetRace()
      race.after.set(1, swapInLink)
      race.before.set(2, () => unlinkSync(path))
      race.after.set(2, swapInLink)
      await expect(open(path)).rejects.toMatchObject({ code: 'ELOOP' })
      unlinkSync(path)
      resetRace()
    }
  })

  it('opens a file another process made between the check and the open, once it is checked again', async () => {
    for (const open of [syncRead, handleRead]) {
      const { path } = scene({ exists: false })
      race.after.set(1, () => writeFileSync(path, 'made'))
      expect(await open(path)).toBe('made')
      unlinkSync(path)
      resetRace()
    }
  })

  it('still truncates a plain file, creates a missing one, and fails an exclusive create of an existing one', async () => {
    for (const open of [syncOpen, handleOpen]) {
      const { path } = scene({ exists: true })
      await open(path, WRITE)
      expect(readFileSync(path, 'utf8')).toBe('')
      await expect(open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)).rejects.toMatchObject({ code: 'EEXIST' })
      unlinkSync(path)
      await open(path, WRITE)
      expect(readFileSync(path, 'utf8')).toBe('')
      writeFileSync(path, 'kept')
      await open(path, constants.O_RDONLY)
      expect(readFileSync(path, 'utf8')).toBe('kept')
      resetRace()
    }
  })
})

async function syncOpen(path: string, flags: number): Promise<void> {
  closeSync(openNoFollow(path, flags, 0o600, 'win32'))
}

async function handleOpen(path: string, flags: number): Promise<void> {
  await (await openHandleNoFollow(path, flags, 'win32')).close()
}

/** Opens for reading as fs_read does, imitating Windows, and reads what the open reached. */
async function syncRead(path: string): Promise<string> {
  const descriptor = openNoFollow(path, constants.O_RDONLY, undefined, 'win32')
  try { return readFileSync(descriptor, 'utf8') } finally { closeSync(descriptor) }
}

async function handleRead(path: string): Promise<string> {
  const handle = await openHandleNoFollow(path, constants.O_RDONLY, 'win32')
  try { return await handle.readFile('utf8') } finally { await handle.close() }
}

/** Each pass of a loop above is its own scene: the watched name's count and swaps start again. */
function resetRace(): void {
  race.count = 0
  race.after.clear()
  race.before.clear()
}
