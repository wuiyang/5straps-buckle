import { closeSync, constants, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import { openHandleNoFollow, openNoFollow, openRealDirectory } from '../common/adapters/beneath.js'
import { descent, isInside, isInsideComparable, isPlainName, nativePath, parentDirectory, pathRoot, withForwardSlashes } from '../common/domain/paths.js'
import { applySnapshot, restoredLinkType, restoreLink, snapshot } from '../common/services/history/snapshot.js'

// Buckle names every path with pathe. These tests give the path helpers and the sandbox's walks Windows-shaped input
// on Linux, and imitate Windows' open, which has no O_NOFOLLOW, through the platform each check takes.

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'buckle-windows-paths-'))
  roots.push(root)
  return root
}

describe('a path from Windows, read into pathe\'s form', () => {
  it('turns backslashes and mixed separators into slashes and folds the drive letter to upper case', () => {
    expect(nativePath('C:\\proj\\src', 'win32')).toBe('C:/proj/src')
    expect(nativePath('c:\\proj/src\\a.ts', 'win32')).toBe('C:/proj/src/a.ts')
    expect(nativePath('C:\\ws\\..\\other', 'win32')).toBe('C:/other')
    expect(nativePath('C:\\ws\\sub\\..', 'win32')).toBe('C:/ws')
  })

  it('refuses a network share or a device path, which pathe\'s resolve would read as a folder on the current drive', () => {
    for (const shared of ['\\\\server\\share\\proj', '//server/share/proj', '\\\\?\\C:\\proj', '\\\\.\\C:\\proj']) {
      expect(() => nativePath(shared, 'win32')).toThrow(/network share or is a device path/)
    }
  })

  it('refuses a backslash on Linux and macOS, where it is part of a name, and reads a leading // as the root', () => {
    expect(() => nativePath('/home/me/we\\ird', 'linux')).toThrow(/holds a backslash/)
    expect(() => nativePath('/home/me/we\\ird', 'darwin')).toThrow(/holds a backslash/)
    expect(nativePath('//tmp//ws/./a', 'linux')).toBe('/tmp/ws/a')
  })

  it('keeps a link target\'s `..` as written, so it still climbs from where the link lands', () => {
    expect(withForwardSlashes('..\\a\\..\\b', 'win32')).toBe('../a/../b')
    expect(withForwardSlashes('C:\\target\\..\\x', 'win32')).toBe('C:/target/../x')
    expect(() => withForwardSlashes('a\\..\\..\\x', 'linux')).toThrow(/holds a backslash/)
  })
})

describe('roots and walks up', () => {
  it('finds the root of a drive, a share, and a POSIX path, and none for a relative one', () => {
    expect(pathRoot('C:/proj/a')).toBe('C:/')
    expect(pathRoot('c:/proj')).toBe('C:/')
    expect(pathRoot('//server/share/proj')).toBe('//server/share/')
    expect(pathRoot('/home/me')).toBe('/')
    expect(pathRoot('C:proj')).toBe('')
    expect(pathRoot('proj/a')).toBe('')
  })

  it('ends a walk up from C:/a/b at C:/, never at /', () => {
    const visited: string[] = []
    for (let current = 'C:/a/b'; ; current = parentDirectory(current)) {
      visited.push(current)
      if (parentDirectory(current) === current) break
    }
    expect(visited).toEqual(['C:/a/b', 'C:/a', 'C:/'])
  })

  it('ends a walk up from a share at the share, and a POSIX walk at /', () => {
    expect(parentDirectory('//server/share/a')).toBe('//server/share/')
    expect(parentDirectory('//server/share/')).toBe('//server/share/')
    expect(parentDirectory('C:/')).toBe('C:/')
    expect(parentDirectory('/a')).toBe('/')
    expect(parentDirectory('/')).toBe('/')
  })

  it('descends from the root of the path, one directory at a time', () => {
    expect(descent('C:/proj/a')).toEqual(['C:/', 'C:/proj', 'C:/proj/a'])
    expect(descent('//server/share/proj')).toEqual(['//server/share/', '//server/share/proj'])
    expect(descent('/home/me')).toEqual(['/', '/home', '/home/me'])
  })
})

describe('containment on Windows-shaped paths', () => {
  it('holds a path below the workspace and refuses one that climbs out, onto another drive, or onto a share', () => {
    expect(isInside('C:/ws', 'C:/ws/src/a.ts')).toBe(true)
    expect(isInside('C:/ws', 'C:\\ws\\src/a.ts')).toBe(true)
    expect(isInside('C:/ws', 'C:/ws/sub/..')).toBe(true)
    expect(isInside('C:/ws', 'C:/ws/../other')).toBe(false)
    expect(isInside('C:/ws', 'C:/ws/../../..')).toBe(false)
    expect(isInside('C:/ws', 'D:/ws/a')).toBe(false)
    expect(isInside('C:/ws', '//server/share/ws')).toBe(false)
    expect(isInside('C:/ws', 'C:/wsx/a')).toBe(false)
  })

  it('compares case exactly, so a case variant is outside, and a restriction folds case where the disk ignores it', () => {
    expect(isInside('C:/ws', 'C:/WS/a')).toBe(false)
    expect(isInside('C:/ws', 'c:/ws/a')).toBe(true)
    expect(isInsideComparable('C:/Users/me/.5straps', 'c:/users/ME/.5STRAPS/buckle', true)).toBe(true)
  })
})

describe('a directory opened from its own root', () => {
  it('refuses a relative path, and any name that is not one plain name', () => {
    const root = scratch()
    expect(() => openRealDirectory('relative/dir')).toThrow(/not an absolute path/)
    const directory = openRealDirectory(root)
    try {
      expect(() => directory.child('a\\..\\..\\x')).toThrow(/not one plain name/)
      expect(() => directory.child('..')).toThrow(/not one plain name/)
      expect(directory.child('plain.txt')).toMatch(/plain\.txt$/)
    } finally { directory.close() }
    expect(isPlainName('a\\b')).toBe(false)
    expect(isPlainName('notes.txt')).toBe(true)
  })
})

describe('an open that follows no link, with Windows imitated', () => {
  it('refuses a link with ELOOP on Windows as O_NOFOLLOW does elsewhere, and opens a plain file', () => {
    const root = scratch()
    writeFileSync(join(root, 'secret'), 'secret')
    writeFileSync(join(root, 'plain'), 'plain')
    symlinkSync(join(root, 'secret'), join(root, 'link'))
    for (const platform of ['win32', 'linux'] as const) {
      expect(() => openNoFollow(join(root, 'link'), constants.O_RDONLY, undefined, platform)).toThrow(expect.objectContaining({ code: 'ELOOP' }))
      const descriptor = openNoFollow(join(root, 'plain'), constants.O_RDONLY, undefined, platform)
      const buffer = Buffer.alloc(5)
      try { readSync(descriptor, buffer) } finally { closeSync(descriptor) }
      expect(buffer.toString()).toBe('plain')
    }
  })

  it('creates a file that did not exist, and refuses a directory junction as a link', () => {
    const root = scratch()
    const descriptor = openNoFollow(join(root, 'new'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600, 'win32')
    closeSync(descriptor)
    expect(readFileSync(join(root, 'new'), 'utf8')).toBe('')
    mkdirSync(join(root, 'target'))
    symlinkSync(join(root, 'target'), join(root, 'junction'))
    expect(() => openNoFollow(join(root, 'junction'), constants.O_RDONLY, undefined, 'win32')).toThrow(expect.objectContaining({ code: 'ELOOP' }))
  })

  it('does the same for a FileHandle', async () => {
    const root = scratch()
    writeFileSync(join(root, 'plain'), 'plain')
    symlinkSync(join(root, 'plain'), join(root, 'link'))
    await expect(openHandleNoFollow(join(root, 'link'), constants.O_RDONLY, 'win32')).rejects.toMatchObject({ code: 'ELOOP' })
    const handle = await openHandleNoFollow(join(root, 'plain'), constants.O_RDONLY, 'win32')
    try { expect((await handle.readFile()).toString()).toBe('plain') } finally { await handle.close() }
  })
})

describe('history on Windows, imitated', () => {
  it('restores a link to a directory as a junction and any other as a file link', () => {
    const root = scratch()
    mkdirSync(join(root, 'folder'))
    writeFileSync(join(root, 'file'), 'file')
    expect(restoredLinkType({ target: 'folder', parent: root, platform: 'win32' })).toBe('junction')
    expect(restoredLinkType({ target: 'file', parent: root, platform: 'win32' })).toBe('file')
    expect(restoredLinkType({ target: 'missing', parent: root, platform: 'win32' })).toBe('file')
    expect(restoredLinkType({ target: 'folder', parent: root, platform: 'linux' })).toBeUndefined()
  })

  it('reports a file link Windows refuses for lack of privilege, and passes any other failure on', () => {
    const refuse = (code: string) => () => { throw Object.assign(new Error(code), { code }) }
    const input = { target: 'missing', at: '/nowhere/link', parent: scratch(), shown: 'C:/ws/link', platform: 'win32' as const }
    expect(() => restoreLink({ ...input, symlink: refuse('EPERM') })).toThrow('Windows refused to make the symbolic link C:/ws/link: a file link needs Developer Mode or an administrator, so the restore stopped there')
    expect(() => restoreLink({ ...input, symlink: refuse('EEXIST') })).toThrow('EEXIST')
  })

  it('restores links through the Windows path, whose type Linux ignores', () => {
    const root = scratch()
    mkdirSync(join(root, 'folder'))
    const path = join(root, 'link')
    applySnapshot({ current: {}, target: { [path]: { kind: 'symlink', mode: 0o777, target: 'folder' } }, paths: [path], content: () => Buffer.alloc(0), roots: [root], platform: 'win32' })
    expect(readlinkSync(path)).toBe('folder')
  })

  it('refuses to capture a name holding a backslash, which pathe would record as another path', () => {
    const root = scratch()
    // Joined by hand: pathe's join would read the backslashes as separators.
    writeFileSync(`${root}/inside\\..\\..\\x`, 'literal')
    expect(() => snapshot({ roots: [root], excluded: [], maxBytes: 1_000_000, save: () => {} })).toThrow('History cannot capture a file name holding a backslash')
  })
})
