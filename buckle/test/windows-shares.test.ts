import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveProgram, rootsOf, trustedSearchPath } from '../common/domain/executable.js'
import { createPathView, OUTSIDE_PATH } from '../common/domain/path-view.js'
import { isInside, isInsideComparable, nativePath, shareRoot, typedShare } from '../common/domain/paths.js'
import { resolveTarget } from '../common/services/invocation/real-path.js'
import { canonicalMountSource } from '../common/services/workspaces/workspace-dirs.js'

// D84 (1) and Q8 of the workspace-model brief: on Windows a network share or a mapped drive is reached only where a
// mount of the workspace holds it; a mapped drive is stored as the share it points to; a device path stays refused;
// everywhere else keeps the 0.1.5 refusal. Windows is imitated through the platform each check takes, as the other
// Windows path tests do; on Linux and macOS nothing of this applies, as a leading `//` is the root there.

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-shares-')))
  roots.push(root)
  return root
}

const DOCS = '//fileserver/team/docs'

describe('a path on a share, read on Windows', () => {
  it('is refused, as in 0.1.5, where no mount holds it', () => {
    for (const path of ['\\\\fileserver\\team\\docs\\a.txt', '//fileserver/team/docs']) {
      expect(() => nativePath(path, 'win32')).toThrow(/network share or is a device path/)
      expect(() => nativePath(path, 'win32', ['//fileserver/team/other'])).toThrow(/network share or is a device path/)
      expect(() => nativePath(path, 'win32', ['//otherserver/team'])).toThrow(/network share or is a device path/)
    }
  })

  it('is read, folded beneath its share, where a mount\'s source holds it, compared without regard to case', () => {
    expect(nativePath('\\\\fileserver\\team\\docs\\a.txt', 'win32', [DOCS])).toBe('//fileserver/team/docs/a.txt')
    expect(nativePath('\\\\FileServer\\Team\\Docs\\sub\\..\\b.txt', 'win32', [DOCS])).toBe('//FileServer/Team/Docs/b.txt')
    expect(nativePath('//fileserver/team/docs', 'win32', [DOCS])).toBe(DOCS)
    // A `..` at the share stays there, as Windows folds it, and lands outside the mount: refused.
    expect(() => nativePath('\\\\fileserver\\team\\docs\\..\\..\\..\\secrets', 'win32', [DOCS])).toThrow(/network share/)
  })

  it('stays refused as a device path, whatever a mount holds', () => {
    for (const path of ['\\\\?\\C:\\proj', '\\\\.\\C:\\proj', '\\\\?\\UNC\\fileserver\\team\\docs', '//?/UNC/fileserver/team/docs', '\\\\.\\pipe\\x']) {
      expect(() => nativePath(path, 'win32', [DOCS, '//?/UNC', '//./pipe'])).toThrow(/network share or is a device path/)
    }
    expect(typedShare('\\\\?\\UNC\\fileserver\\team')).toEqual([])
    expect(shareRoot('//?/UNC/fileserver')).toBeNull()
    expect(shareRoot('//./pipe/x')).toBeNull()
  })

  it('refuses a stream, and a name Windows programs read as another', () => {
    expect(() => nativePath('\\\\fileserver\\team\\docs\\a.txt:hidden', 'win32', [DOCS])).toThrow(/colon/)
    expect(() => nativePath('\\\\fileserver\\team\\docs\\a.', 'win32', [DOCS])).toThrow(/ends in a dot or a space/)
  })

  it('is no share on Linux or macOS, where a leading // is the root, whatever a mount names', () => {
    expect(nativePath('//fileserver/team/docs', 'linux', [DOCS])).toBe('/fileserver/team/docs')
    expect(nativePath('//fileserver/team/docs', 'darwin', [DOCS])).toBe('/fileserver/team/docs')
  })
})

describe('a share as a root on Windows', () => {
  it('holds only what lies on the same share beneath it', () => {
    expect(isInside(DOCS, `${DOCS}/a/b`, 'win32')).toBe(true)
    expect(isInside(DOCS, DOCS, 'win32')).toBe(true)
    expect(isInside(DOCS, '//fileserver/team/docsx', 'win32')).toBe(false)
    expect(isInside(DOCS, '//fileserver/other/docs', 'win32')).toBe(false)
    // A path rooted at a slash alone lies on the current drive, which pathe's resolve would read as the same place.
    expect(isInside(DOCS, '/fileserver/team/docs/a', 'win32')).toBe(false)
    expect(isInside('/fileserver/team', `${DOCS}/a`, 'win32')).toBe(false)
    expect(isInside('C:/', `${DOCS}/a`, 'win32')).toBe(false)
    expect(isInsideComparable(DOCS, '//FILESERVER/Team/DOCS/a', true, 'win32')).toBe(true)
  })
})

describe('a mount\'s source on Windows', () => {
  function shareFolder(): string {
    const real = scratch()
    mkdirSync(join(real, 'docs'))
    return real
  }

  it('is stored as the share a mapped drive points to, as the system resolves the letter', () => {
    const real = shareFolder()
    const stored = (path: string) => (path === 'Z:\\docs' ? '\\\\fileserver\\team\\docs' : path)
    // The share's folder exists here as a Linux folder: //<server>/<share> reads as /<server>/<share> on this host.
    const share = `/${real}/docs`
    const resolved = canonicalMountSource('Z:\\docs', 'win32', path => (path === 'Z:\\docs' ? share.replaceAll('/', '\\') : stored(path)))
    expect(resolved).toBe(`/${real}/docs`)
  })

  it('may be typed as a share, and is refused as a device path, as a whole share, or where it does not exist', () => {
    const real = shareFolder()
    const typed = `\\\\${real.slice(1).replaceAll('/', '\\')}\\docs`
    expect(canonicalMountSource(typed, 'win32', path => path)).toBe(`/${real}/docs`)
    expect(() => canonicalMountSource('\\\\?\\C:\\docs', 'win32', path => path)).toThrow(/device path/)
    expect(() => canonicalMountSource('Z:\\docs', 'win32', () => '\\\\?\\UNC\\fileserver\\team\\docs')).toThrow(/device path/)
    expect(() => canonicalMountSource('Z:\\', 'win32', path => path)).toThrow(/whole drive/)
    expect(() => canonicalMountSource('Z:\\team', 'win32', () => '\\\\fileserver\\team')).toThrow(/whole drive/)
    expect(() => canonicalMountSource('Z:\\gone', 'win32', () => { throw new Error('ENOENT') })).toThrow(/existing folder or file/)
  })
})

describe('a workspace\'s view of a mount on a share, on Windows', () => {
  const view = createPathView({ root: 'C:/work/site', mount: '/workspace', mounts: [{ source: DOCS, target: '/docs', access: 'ro' }], platform: 'win32' })

  it('keeps the share as its source, and resolves the target onto it', () => {
    expect(view.shares).toEqual([DOCS])
    expect(view.reachableRoots).toEqual(['C:/work/site', DOCS])
    expect(view.resolve('/docs/guide/a.md')).toBe(`${DOCS}/guide/a.md`)
    expect(view.resolve('\\docs\\guide\\a.md')).toBe(`${DOCS}/guide/a.md`)
    expect(view.resolve('\\\\fileserver\\team\\docs\\a.md')).toBe(`${DOCS}/a.md`)
  })

  it('refuses the rest of the share, another share, and a device path, naming no host path', () => {
    for (const path of ['\\\\fileserver\\team\\private\\a.md', '\\\\otherserver\\team\\docs\\a.md', '\\\\?\\UNC\\fileserver\\team\\docs\\a.md', '/docs/../../x']) {
      expect(() => view.resolve(path)).toThrow()
    }
    expect(() => view.resolve('\\\\fileserver\\team\\private\\a.md')).toThrow(/network share or is a device path/)
  })

  it('shows a real path on the share by its target, and the rest of the share by no name', () => {
    expect(view.toVirtual(`${DOCS}/guide/a.md`)).toBe('/docs/guide/a.md')
    expect(view.toVirtual(DOCS)).toBe('/docs')
    expect(view.toVirtual('//fileserver/team/private')).toBe(OUTSIDE_PATH)
    expect(view.display(`${DOCS}/a.md`)).toBe('/docs/a.md')
    expect(view.mountOf(`${DOCS}/a.md`)).toMatchObject({ target: '/docs' })
  })

  it('reaches no share on Linux, where the same table names a folder at the root', () => {
    const linux = createPathView({ root: '/work/site', mount: '/workspace', mounts: [{ source: DOCS, target: '/docs', access: 'ro' }], platform: 'linux' })
    expect(linux.shares).toEqual([])
    expect(linux.resolve('/docs/a.md')).toBe('/fileserver/team/docs/a.md')
  })
})

describe('where a path on a share lands, on Windows', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('is the share path the system answers, where a mount holds it, and refused, as in 0.1.5, where none does', () => {
    vi.spyOn(realpathSync, 'native').mockImplementation(((path: string) => path.replaceAll('/', '\\')) as typeof realpathSync.native)
    expect(resolveTarget(`${DOCS}/a.txt`, { shares: [DOCS], platform: 'win32' })).toBe(`${DOCS}/a.txt`)
    expect(() => resolveTarget(`${DOCS}/a.txt`, { platform: 'win32' })).toThrow(/network share or is a device path/)
    expect(() => resolveTarget('//fileserver/team/private/a.txt', { shares: [DOCS], platform: 'win32' })).toThrow(/network share or is a device path/)
  })
})

describe('a program on a share, on Windows', () => {
  // The share's folder exists here as a Linux folder (//<server>/<share> reads as /<server>/<share> on this host), and the
  // system's resolution answers in the backslash spelling Windows gives a share.
  function onShare() {
    const real = scratch()
    mkdirSync(join(real, 'tools'))
    writeFileSync(join(real, 'tools', 'rg.exe'), '')
    chmodSync(join(real, 'tools', 'rg.exe'), 0o755)
    const tools = `/${real}/tools`
    const storedPath = (path: string) => (path.startsWith('//') ? path.replaceAll('/', '\\') : realpathSync.native(path))
    return { tools, program: `${tools}/rg.exe`, storedPath }
  }

  it('runs where a read-only mount of the workspace holds it, and is refused as in 0.1.5 where none does', () => {
    const { tools, program, storedPath } = onShare()
    const found = resolveProgram('rg', { untrustedRoots: [], lookup: () => program, platform: 'win32', storedPath, shares: [tools] })
    expect(found).toMatchObject({ path: program, argv0: program })
    expect(resolveProgram('rg', { untrustedRoots: [], lookup: () => program, platform: 'win32', storedPath })).toEqual({ path: null, reason: 'rg is a path Buckle cannot read as the system does, so Buckle does not run it', untrusted: false })
  })

  it('is refused from a mount shared writable, as an agent can write there', () => {
    const { tools, program, storedPath } = onShare()
    expect(resolveProgram('rg', { untrustedRoots: rootsOf('writable mount', [tools]), lookup: () => program, platform: 'win32', storedPath, shares: [tools] })).toMatchObject({ path: null, untrusted: true, reason: 'rg is found in or through the source of a writable mount of this node, where an agent can write, so Buckle does not run it' })
  })

  it('keeps a PATH entry on a share only where a mount holds it', () => {
    const { tools, storedPath } = onShare()
    const entry = tools.replaceAll('/', '\\')
    expect(trustedSearchPath(`${entry};C:\\Windows`, { untrustedRoots: [] }, 'win32', storedPath, [tools])).toBe(`${entry};C:\\Windows`)
    expect(trustedSearchPath(`${entry};C:\\Windows`, { untrustedRoots: [] }, 'win32', storedPath)).toBe('C:\\Windows')
  })
})
