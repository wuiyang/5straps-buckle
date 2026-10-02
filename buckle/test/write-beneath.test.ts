import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LinkAppearedError, withFileBeneath } from '../common/adapters/beneath.js'
import { constants } from 'node:fs'
import { createPathView } from '../common/domain/path-view.js'
import { patchFile, writeFileEntry } from '../common/services/packs/fs/operations.js'

// Review H1 of B23-B25: a writer creates files beneath a parent it opened without following a link, and
// writes only where the permission check looked (filesystem-boundary.md, "File tool resolution").

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'buckle-beneath-'))
  roots.push(root)
  mkdirSync(join(root, 'workspace', 'folder'), { recursive: true })
  mkdirSync(join(root, 'outside'))
  return { root, workspace: join(root, 'workspace'), outside: join(root, 'outside'), paths: createPathView({ root: join(root, 'workspace'), mount: null }) }
}

describe('a write beneath a pinned parent', () => {
  it('refuses when the name it opens became a link after the check', () => {
    const { workspace, outside } = fixture()
    symlinkSync(join(outside, 'target.txt'), join(workspace, 'swapped.txt'))
    expect(() => withFileBeneath(join(workspace, 'swapped.txt'), { flags: constants.O_WRONLY | constants.O_CREAT }, () => undefined)).toThrow(LinkAppearedError)
    expect(existsSync(join(outside, 'target.txt'))).toBe(false)
  })

  it('refuses when a parent became a link after the check, and creates nothing past it', () => {
    const { workspace, outside } = fixture()
    symlinkSync(outside, join(workspace, 'moved'))
    expect(() => withFileBeneath(join(workspace, 'moved', 'deeper', 'file.txt'), { flags: constants.O_WRONLY | constants.O_CREAT, createParents: true }, () => undefined)).toThrow(LinkAppearedError)
    expect(existsSync(join(outside, 'deeper'))).toBe(false)
  })

  it('creates missing parents beneath the pinned directory', () => {
    const { workspace } = fixture()
    withFileBeneath(join(workspace, 'a', 'b', 'file.txt'), { flags: constants.O_WRONLY | constants.O_CREAT, createParents: true }, () => undefined)
    expect(existsSync(join(workspace, 'a', 'b', 'file.txt'))).toBe(true)
  })
})

describe('the fs pack writes only what its permission check judged', () => {
  it('refuses a target a link swapped in while the call waited', async () => {
    const { workspace, outside, paths } = fixture()
    // Judged as the plain file notes.txt; by the time it runs, notes.txt is a link out of the workspace.
    const judged = join(workspace, 'notes.txt')
    symlinkSync(join(outside, 'planted.txt'), judged)
    const authorizeWrite = (target: string) => target === judged
    await expect(writeFileEntry({ path: 'notes.txt', content: 'x', encoding: 'utf8', createParents: false }, { paths, authorizeWrite })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    await expect(patchFile({ path: 'notes.txt', edits: [{ oldText: 'a', newText: 'b', replaceAll: false }] }, { paths, authorizeWrite })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(existsSync(join(outside, 'planted.txt'))).toBe(false)
  })

  it('writes through a link that was judged at its target, and leaves the link in place', async () => {
    const { workspace, paths } = fixture()
    writeFileSync(join(workspace, 'folder', 'AGENTS.md'), 'before\n')
    symlinkSync('folder/AGENTS.md', join(workspace, 'CLAUDE.md'))
    const target = join(workspace, 'folder', 'AGENTS.md')
    await writeFileEntry({ path: 'CLAUDE.md', content: 'after\n', encoding: 'utf8', createParents: false }, { paths, authorizeWrite: path => path === target })
    expect(readFileSync(target, 'utf8')).toBe('after\n')
    await patchFile({ path: 'CLAUDE.md', edits: [{ oldText: 'after', newText: 'patched', replaceAll: false }] }, { paths, authorizeWrite: path => path === target })
    expect(readFileSync(target, 'utf8')).toBe('patched\n')
  })

  it('replaces a shorter file in place when saving with its revision', async () => {
    const { workspace, paths } = fixture()
    writeFileSync(join(workspace, 'saved.txt'), 'a much longer original line\n')
    const { createHash } = await import('node:crypto')
    const expectedHash = createHash('sha256').update('a much longer original line\n').digest('hex')
    await writeFileEntry({ path: 'saved.txt', content: 'short\n', encoding: 'utf8', createParents: false, expectedHash }, { paths })
    expect(readFileSync(join(workspace, 'saved.txt'), 'utf8')).toBe('short\n')
  })
})
