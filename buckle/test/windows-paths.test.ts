import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { win32 } from 'node:path'
import { join } from 'pathe'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyWorkspacePolicy, MountPathSchema, WorkspacePolicySchema } from '@5straps/protocol'
import { openHandleNoFollow, openNoFollow, openRealDirectory } from '../common/adapters/beneath.js'
import { resolveProgram, rootsOf } from '../common/domain/executable.js'
import { createFilesystemPolicyRule, filesystemPathDecision, projectFilesystemSandbox } from '../common/domain/filesystem-policy.js'
import { createPathView } from '../common/domain/path-view.js'
import { childPath, descent, isDriveRoot, isInside, isInsideComparable, isPlainName, nativePath, parentDirectory, pathRoot, resolvePath, typedPath, WHOLE_DRIVE, withForwardSlashes, workingDirectory } from '../common/domain/paths.js'
import { createReadScopeRule } from '../common/domain/permission/rules/read-scope-rule.js'
import { clientDirectory } from '../cli/client.js'
import { runInit } from '../cli/init.js'
import { scratchSources, stateDirectoryOf, workspaceHolds } from '../common/runtime/config.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { resolveTarget } from '../common/services/invocation/real-path.js'
import { workspacesOf } from './support/workspaces.js'
import { logger } from '../common/runtime/log.js'
import { openChangeHistory } from '../common/services/history/journal.js'
import { applySnapshot, restoredLinkType, restoreLink, snapshot } from '../common/services/history/snapshot.js'
import { collectShellHiddenPaths } from '../common/services/shell/shell-filesystem.js'
import { createWorkbenchFiles } from '../common/services/workbench/files.js'
import { findNames, listTree } from '../common/services/packs/fs/operations.js'
import { findInput, listInput, searchInput } from '../common/services/packs/fs/schemas.js'
import { searchContent } from '../common/services/packs/fs/search.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { fixedInteraction, headlessGrace } from './support/interaction.js'
import { settleAuditLogs } from './support/action-log-writer.js'

// Buckle names every path with pathe. These tests give the path helpers and the sandbox's walks Windows-shaped input
// on Linux, and imitate Windows' open, which has no O_NOFOLLOW, through the platform each check takes.

const roots: string[] = []
afterEach(async () => { await settleAuditLogs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

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

  it('refuses a backslash or a leading drive letter on Linux and macOS, where both are part of a name, and reads a leading // as the root', () => {
    expect(() => nativePath('/home/me/we\\ird', 'linux')).toThrow(/holds a backslash/)
    expect(() => nativePath('/home/me/we\\ird', 'darwin')).toThrow(/holds a backslash/)
    expect(() => nativePath('c:/state', 'linux')).toThrow(/starts with a drive letter/)
    expect(nativePath('c:notes', 'linux')).toBe('c:notes')
    expect(nativePath('//tmp//ws/./a', 'linux')).toBe('/tmp/ws/a')
  })

  it('keeps a link target\'s `..` as written, so it still climbs from where the link lands', () => {
    expect(withForwardSlashes('..\\a\\..\\b', 'win32')).toBe('../a/../b')
    expect(withForwardSlashes('C:\\target\\..\\x', 'win32')).toBe('C:/target/../x')
    expect(() => withForwardSlashes('a\\..\\..\\x', 'linux')).toThrow(/holds a backslash/)
  })

  /**
   * How Buckle reads a path on Windows: folded as node's own Windows normalize folds it, `.` and `..` alone, with no name
   * trimmed, as Node opens every path with the `\\?\` prefix, which Windows reads as written. Null exactly where
   * trimming the dots and spaces that end a name would change one, which Buckle refuses: a program it starts there, handed
   * a path without that prefix (its working directory), trims them and reaches another name.
   */
  function buckleReads(typed: string): string | null {
    const normalized = win32.normalize(typed)
    return normalized.split('\\').some(name => !['.', '..'].includes(name) && name.replace(/[. ]+$/, '') !== name) ? null : normalized.replaceAll('\\', '/')
  }

  // Every spelling of up to four pieces after `C:` and a separator, each a separator, a dot, two dots, a name, or a
  // space, folded as node's own Windows normalize folds it, or refused where a name ends in a dot or a space.
  it('folds every drive-rooted spelling as Windows does, whatever separators, dots, names, and spaces follow the drive', () => {
    const pieces = ['/', '\\', '.', '..', 'x', ' ', 'a b']
    const tails = (length: number): string[] => length === 0 ? [''] : tails(length - 1).flatMap(head => pieces.map(piece => head + piece))
    let folded = 0
    let refused = 0
    for (const separator of ['/', '\\']) {
      for (let length = 0; length <= 4; length++) {
        for (const tail of tails(length)) {
          const typed = `C:${separator}${tail}`
          const opened = buckleReads(typed)
          if (opened === null) {
            expect(() => nativePath(typed, 'win32'), typed).toThrow(/holds a name that ends in a dot or a space, which Windows programs read as another name/)
            refused++
          } else {
            expect(nativePath(typed, 'win32'), typed).toBe(opened)
            folded++
          }
        }
      }
    }
    expect(folded + refused).toBe(2 * (1 + 7 + 49 + 343 + 2401))
    expect(refused).toBeGreaterThan(0)
    expect(nativePath('C:\\x.\\..\\.github\\workflows', 'win32')).toBe('C:/.github/workflows')
    expect(() => nativePath('C:\\x.\\.github.\\workflows. ', 'win32')).toThrow(/ends in a dot or a space/)
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

  it('keeps two drives apart on Windows, whatever the path below each', () => {
    expect(isInside('C:/ws', 'D:/x', 'win32')).toBe(false)
    expect(isInside('C:/ws', 'D:/ws/x', 'win32')).toBe(false)
    expect(isInsideComparable('c:/ws', 'D:/WS/x', true, 'win32')).toBe(false)
    expect(isInside('C:/ws', 'C:/ws/x', 'win32')).toBe(true)
  })
})

// pathe's isAbsolute reads `c:/x` as a drive, so the relative path from a workspace to its folder `c:` read as outside
// it: a workspace deny there was skipped, and a grant on the workspace let the call through.
describe('a folder named like a drive on Linux and macOS: <ws>/c:/x', () => {
  it('is inside its workspace on both', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      expect(isInside('/ws', '/ws/c:/x', platform)).toBe(true)
      expect(isInside('/ws', '/ws/C:', platform)).toBe(true)
      expect(isInsideComparable('/ws', '/ws/C:/x', true, platform)).toBe(true)
      expect(isInside('/ws/c:', '/ws/x', platform)).toBe(false)
    }
  })

  it('meets a workspace deny on it, which a grant on the workspace does not lift', () => {
    const root = scratch()
    const policy = WorkspacePolicySchema.parse({ ...emptyWorkspacePolicy(), filesystem: { rules: [{ path: 'c:', read: 'deny' }] } })
    const rule = createFilesystemPolicyRule({ root, policy })
    const effect = { kind: 'read_path' as const, path: `${root}/c:/x`, directory: `${root}/c:` }
    expect(rule.evaluate({ tool: 'fs_read', effect, grants: { subjectsFor: () => [root] } })).toMatchObject({ kind: 'deny', rule: 'filesystem_policy' })
  })

  it('keeps a state directory there inside the workspace, which refuses to start', () => {
    const root = scratch()
    expect(() => configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: root, BUCKLE_STATE_DIR: `${root}/c:/state` })).toThrow(/inside the BUCKLE_WORKSPACE_ROOT/)
  })
})

describe('the agent\'s paths on a Windows workspace, imitated', () => {
  const view = createPathView({ root: 'C:/ws', mount: null, platform: 'win32' })
  const mounted = createPathView({ root: 'C:/ws', mount: '/workspace', platform: 'win32' })

  it('reads backslashes and mixed separators as separators, and shows paths with slashes', () => {
    expect(view.resolve('src\\a.ts')).toBe('C:/ws/src/a.ts')
    expect(view.resolve('C:\\ws\\src/a.ts')).toBe('C:/ws/src/a.ts')
    expect(view.resolve('src\\sub\\..')).toBe('C:/ws/src')
    expect(view.display('C:/ws/src/a.ts')).toBe('src/a.ts')
    expect(mounted.toVirtual('C:/ws/src/a.ts')).toBe('/workspace/src/a.ts')
  })

  // A climb past a drive's root stops there, as on Windows; pathe's own resolve went on to `/`, the current drive's root.
  it('names a path that climbs out, a case variant, or another drive as the place it is, outside the root', () => {
    for (const [named, landed] of [['C:\\ws\\..\\other', 'C:/other'], ['..\\..\\x', 'C:/x'], ['C:\\WS\\src', 'C:/WS/src'], ['D:\\ws\\a', 'D:/ws/a']]) {
      expect(view.resolve(named!)).toBe(landed)
      expect(isInside(view.root, landed!)).toBe(false)
    }
  })

  it('refuses under a mount every path that leaves it, a share included', () => {
    expect(mounted.resolve('\\workspace\\src\\a.ts')).toBe('C:/ws/src/a.ts')
    for (const named of ['\\workspace\\..\\other', 'C:\\other', 'D:\\ws\\a']) {
      expect(() => mounted.resolve(named)).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }))
    }
    expect(() => mounted.resolve('\\\\server\\share\\x')).toThrow(/network share/)
  })

  // NTFS reads a colon after a name as a stream of that file: a write there lands where listings and history never
  // look, and `.env::$DATA` is `.env` to Windows while the sensitive-path rule reads another name.
  it('refuses a colon that is not a drive letter\'s, so no file stream and no drive-relative path is reached', () => {
    for (const named of ['notes.txt:payload', '.env::$DATA', 'src\\a.ts:hidden', 'C:\\ws\\a:b', 'D:foo', 'C:/ws/x:']) {
      expect(() => nativePath(named, 'win32')).toThrow(/holds a colon that is not a drive letter's/)
      expect(() => view.resolve(named)).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }))
    }
    expect(view.resolve('C:\\ws\\notes.txt')).toBe('C:/ws/notes.txt')
    expect(nativePath('D:', 'win32')).toBe('D:/')
    expect(nativePath('notes.txt:payload', 'linux')).toBe('notes.txt:payload')
  })

  // Node opens every path with the `\\?\` prefix, so Buckle's own open of `.github\workflows.\ci.yml` reaches a literal
  // `workflows.`. A program handed a path without it is another matter: a child's working directory reaches
  // CreateProcessW unprefixed, which trims the dots and spaces that end a name, so git started in a judged `.ssh.\repo`
  // ran in `.ssh\repo`. A name that ends in a dot or a space is refused, never trimmed to a sibling's.
  it('refuses a path holding a name that ends in a dot or a space, wherever it is and whatever trimming would leave', () => {
    for (const named of ['.github\\workflows.\\ci.yml', '.github.\\workflows\\ci.yml. ', 'C:\\ws\\.github\\workflows.\\ci.yml . ', '.github\\workflows .\\ci.yml', 'secret \\', 'secret..\\', '.ssh...\\repo', 'notes\\...', '.github\\.. ', 'src\\ ', 'a\\...\\b', 'C:\\ws\\. .', 'a \\b']) {
      expect(() => nativePath(named, 'win32'), named).toThrow(`${named} holds a name that ends in a dot or a space, which Windows programs read as another name, so Buckle refuses it rather than read it as another path`)
      expect(() => view.resolve(named), named).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }))
    }
    // `.` and `..` are still folded, and a name with a dot or a space inside it is kept.
    expect(view.resolve('.github\\workflows.\\..\\ci.yml')).toBe('C:/ws/.github/ci.yml')
    expect(view.resolve('a b\\c.d\\.e')).toBe('C:/ws/a b/c.d/.e')
    // Linux and macOS keep every name as written.
    expect(nativePath('/ws/src./a.ts. ', 'linux')).toBe('/ws/src./a.ts. ')
  })

  // The system's answers are read the same way: a real path, a link's target, or the working directory with such a name
  // is refused, never renamed (a root `C:\code\app.` was judged as its sibling `app`).
  it('refuses such a name in a real path, a link target, or the working directory', () => {
    expect(() => nativePath('C:\\code\\app.', 'win32')).toThrow(/ends in a dot or a space/)
    expect(() => withForwardSlashes('..\\.ssh.\\repo', 'win32')).toThrow(/ends in a dot or a space/)
    expect(withForwardSlashes('..\\a\\..\\b', 'win32')).toBe('../a/../b')
    vi.spyOn(process, 'cwd').mockReturnValue('C:\\ws\\app ')
    try { expect(() => workingDirectory('win32')).toThrow(/ends in a dot or a space/) } finally { vi.restoreAllMocks() }
    expect(isPlainName('app.', 'win32')).toBe(false)
    expect(isPlainName('app ', 'win32')).toBe(false)
    expect(isPlainName('.env', 'win32')).toBe(true)
    expect(isPlainName('app.', 'linux')).toBe(true)
  })

  it('leaves an entry with such a name out of a listing, a name search, and a content search', async () => {
    const root = scratch()
    for (const name of ['app.', 'notes ', 'kept.txt']) writeFileSync(join(root, name), 'needle')
    const context = { paths: createPathView({ root, mount: null }), platform: 'win32' as const }
    const listed = await listTree(listInput.parse({ path: '.' }), context) as { entries: Array<{ name: string }> }
    expect(listed.entries.map(entry => entry.name)).toEqual(['kept.txt'])
    expect(await findNames(findInput.parse({ pattern: '*' }), context)).toMatchObject({ matches: ['kept.txt'] })
    const match = JSON.stringify({ type: 'match', data: { lines: { text: 'needle\n' }, line_number: 1, submatches: [{ start: 0, end: 6 }] } })
    const answer = (stdout: string) => ({ exitCode: 0, signal: null, stdout, stderr: '', truncated: false, timedOut: false })
    const found = await searchContent({
      args: searchInput.parse({ pattern: 'needle' }), paths: context.paths, ripgrep: { path: '/usr/bin/rg', argv0: '/usr/bin/rg', args: [] }, protectedRoots: [], platform: 'win32',
      runProcess: async request => answer(request.args[0] === '--files' ? '.\\app.\0.\\notes \0.\\kept.txt\0' : `${match}\n`),
      timeoutMs: 5_000, signal: AbortSignal.timeout(5_000), authorizeRead: async () => true,
    })
    expect(found).toMatchObject({ matches: [{ path: '.\\kept.txt' }], excludedFiles: 2 })
  })
})

// pathe folds each of these to `C:/x`, which the kernel on Linux and macOS opens relative to the working directory, and
// reads `//.hidden.ts` as relative where the kernel reads `/.hidden.ts`.
describe('a spelling pathe folds onto a drive, on Linux and macOS', () => {
  it('is refused by nativePath and by the agent\'s view, as is one the view resolves onto a drive', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const view = createPathView({ root: '/ws', mount: null, platform })
      for (const named of ['./C:/x', '/C:/x', '/./C:/x', 'a/../C:/x', '//C:/x', 'C:', './c:']) {
        expect(() => nativePath(named, platform)).toThrow(/drive letter/)
        expect(() => view.resolve(named)).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }))
      }
      for (const named of ['../C:/x', 'sub/../../C:/x']) expect(() => view.resolve(named)).toThrow(`${named} lands on a drive letter`)
      expect(view.resolve('sub/c:/x')).toBe('/ws/sub/c:/x')
      expect(view.resolve('c:notes')).toBe('/ws/c:notes')
    }
  })

  it('reads a leading // as the root, so //.hidden.ts is /.hidden.ts and //x is /x', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      expect(nativePath('//.hidden.ts', platform)).toBe('/.hidden.ts')
      expect(nativePath('//x', platform)).toBe('/x')
      expect(createPathView({ root: '/ws', mount: null, platform }).resolve('//.hidden.ts')).toBe('/.hidden.ts')
      expect(() => createPathView({ root: '/ws', mount: '/workspace', platform }).resolve('//.hidden.ts')).toThrow(/outside the mounted workspace/)
    }
  })
})

describe('the backslash case on Linux: inside\\..\\..\\x', () => {
  // rg lists the entry by its name; pathe would resolve it to another file, and the search would open that one.
  it('is left out of a content search, counted as excluded, and the file pathe would land on is never opened', async () => {
    const root = scratch()
    const workspace = join(root, 'parent', 'workspace')
    mkdirSync(workspace, { recursive: true })
    // Where pathe lands: inside, then two levels up, is the workspace's parent.
    writeFileSync(join(root, 'parent', 'x'), 'needle outside')
    writeFileSync(`${workspace}/inside\\..\\..\\x`, 'needle literal')
    writeFileSync(join(workspace, 'plain.txt'), 'needle plain')
    const judged: string[] = []
    const answer = (stdout: string) => ({ exitCode: 0, signal: null, stdout, stderr: '', truncated: false, timedOut: false })
    const match = JSON.stringify({ type: 'match', data: { lines: { text: 'needle\n' }, line_number: 1, submatches: [{ start: 0, end: 6 }] } })
    const found = await searchContent({
      args: searchInput.parse({ pattern: 'needle' }), paths: createPathView({ root: workspace, mount: null }), ripgrep: { path: '/usr/bin/rg', argv0: '/usr/bin/rg', args: [] }, protectedRoots: [], platform: 'linux',
      runProcess: async request => answer(request.args[0] === '--files' ? './inside\\..\\..\\x\0./plain.txt\0' : `${match}\n`),
      timeoutMs: 5_000, signal: AbortSignal.timeout(5_000), authorizeRead: async path => { judged.push(path); return true },
    })
    expect(found).toEqual({ matches: [{ path: './plain.txt', line: 1, text: 'needle', ranges: [{ start: 0, end: 6 }] }], truncated: false, excludedFiles: 1 })
    expect(judged).toEqual([join(workspace, 'plain.txt')])
  })

  // pathe would read the name as two levels up and then x; the kernel reads one name. The agent's path is refused,
  // so neither the file outside nor the file of that literal name is read or written.
  it('is refused by the file tools, and neither file is read or written', async () => {
    const root = scratch()
    const workspace = join(root, 'parent', 'workspace')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(root, 'x'), 'outside')
    writeFileSync(`${workspace}/inside\\..\\..\\x`, 'literal')
    expect(() => createPathView({ root: workspace, mount: null }).resolve('inside\\..\\..\\x')).toThrow('inside\\..\\..\\x holds a backslash, which Buckle reads as a separator, so Buckle refuses it rather than read it as another path')
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs' })
    const runtime = await createRuntime({ config, interaction: fixedInteraction(headlessGrace) })
    try {
      for (const [tool, args] of [['fs_read', { path: 'inside\\..\\..\\x' }], ['fs_write', { path: 'inside\\..\\..\\x', content: 'written' }]] as const) {
        const result = await runtime.invoke({ sessionId: 'backslash', request: { requestId: tool, tool, args, approvalTokens: [] }, approvalWait: { mode: 'none' } })
        expect(result).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED' } })
        expect(JSON.stringify(result)).not.toMatch(/outside|literal/)
      }
      // A write beside the entry goes through: history leaves the entry out rather than failing the call.
      await runtime.grants.grant({ sessionId: 'backslash', rule: 'write_scope', subject: workspace, scope: 'session' })
      const beside = await runtime.invoke({ sessionId: 'backslash', request: { requestId: 'beside', tool: 'fs_write', args: { path: 'notes.md', content: 'notes' }, approvalTokens: [] }, approvalWait: { mode: 'none' } })
      expect(beside).toMatchObject({ outcome: 'ok' })
      expect(readFileSync(join(workspace, 'notes.md'), 'utf8')).toBe('notes')
    } finally { await runtime.history.close() }
    expect(readFileSync(join(root, 'x'), 'utf8')).toBe('outside')
    expect(readFileSync(`${workspace}/inside\\..\\..\\x`, 'utf8')).toBe('literal')
  })
})

// Windows keeps a path's case as typed where the disk ignores it: the root and scratch roots are named as the disk
// stores them, and a path compared with one is too. realpathSync.native answers as Windows would here.
describe('case and links on Windows, imitated', () => {
  function diskCase(typed: string, disk: string) {
    const native = realpathSync.native
    return vi.spyOn(realpathSync, 'native').mockImplementation(((path: string, options?: unknown) => path === typed ? disk : native(path, options as undefined)) as typeof realpathSync.native)
  }
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

  it('names a scratch root as the disk does, through a link or in another case', () => {
    const root = scratch()
    mkdirSync(join(root, 'Scratch'))
    symlinkSync(join(root, 'Scratch'), join(root, 'link'))
    diskCase(join(root, 'scratch'), join(root, 'Scratch'))
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: root, BUCKLE_STATE_DIR: join(scratch(), 'state'), BUCKLE_SCRATCH_ROOTS: `${join(root, 'link')},${join(root, 'scratch')}` })
    expect(scratchSources(config.mounts)).toEqual([join(root, 'Scratch'), join(root, 'Scratch')])
  })

  it('refuses in init, as the node does, a workspace that holds the state directory through a link or in another case', async () => {
    const root = scratch()
    mkdirSync(join(root, 'real', 'state'), { recursive: true })
    symlinkSync(join(root, 'real'), join(root, 'link'))
    expect(workspaceHolds('/x/WS', '/x/ws/state', 'win32')).toBe(true)
    expect(workspaceHolds('/x/WS', '/x/ws/state', 'linux')).toBe(false)
    expect(workspaceHolds(join(root, 'link'), join(root, 'real', 'state'))).toBe(true)
    vi.stubEnv('BUCKLE_STATE_DIR', join(root, 'real', 'state'))
    vi.stubEnv('BUCKLE_ENV_FILE', undefined)
    let printed = ''
    vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { printed += String(chunk); return true })
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const prompt = { interactive: false, question: async () => '', say: () => {}, close: () => {} }
    expect((await runInit(['--root', join(root, 'link'), '--yes'], prompt)).exitCode).toBe(1)
    expect(printed).toContain('holds the state directory')
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

  it('refuses, outside history, to capture a name holding a backslash, and names it from its root as listed', () => {
    const root = scratch()
    mkdirSync(join(root, 'sub'))
    // Joined by hand: pathe's join would read the backslashes as separators.
    writeFileSync(`${root}/sub/inside\\..\\..\\x`, 'literal')
    expect(() => snapshot({ roots: [root], excluded: [], maxBytes: 1_000_000, save: () => {} })).toThrow('History cannot capture sub/inside\\..\\..\\x, whose name Buckle would read as another path: a backslash, a separator to Buckle, or on Windows a dot or a space that ends it')
  })

  it('leaves out a name that ends in a dot or a space, and names it from its root as listed', () => {
    const root = scratch()
    mkdirSync(join(root, 'sub'))
    for (const name of ['app.', 'notes ', 'kept.txt']) writeFileSync(join(root, 'sub', name), name)
    const named: string[] = []
    const captured = snapshot({ roots: [root], excluded: [], maxBytes: 1_000_000, save: () => {}, onBackslashName: shown => { named.push(shown) }, platform: 'win32' })
    expect(named.sort()).toEqual(['sub/app.', 'sub/notes '])
    expect(captured[join(root, 'sub', 'app.')]).toMatchObject({ kind: 'excluded' })
    expect(captured[join(root, 'sub', 'kept.txt')]).toMatchObject({ kind: 'file' })
  })
})

// One backslash-named entry anywhere in a Linux workspace stopped every write and tracked command, and the agent saw only
// that the tool failed. History now leaves it out, as it does a hard-linked dependency, and says so once in the log.
describe('history beside a name holding a backslash, on Linux', () => {
  it('leaves the entry out, names it once, records the writes beside it, and refuses a restore that would remove it', async () => {
    const root = scratch()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    writeFileSync(`${workspace}/inside\\..\\..\\x`, 'literal')
    const history = await openChangeHistory({ directory: join(root, 'history'), excluded: [], maxBytes: 1_000_000, retentionDays: 30 })
    const warn = vi.spyOn(logger, 'warn')
    try {
      const details = { sessionId: 'backslash', stageId: 'stage', tool: 'fs_write', roots: [workspace] }
      await history.run(details, async () => { writeFileSync(join(workspace, 'notes.md'), 'notes') })
      await history.run(details, async () => { mkdirSync(join(workspace, 'made')); writeFileSync(`${workspace}/made/a\\b`, 'made') })
      const [first, second] = await history.list()
      expect(first!.paths).toEqual([join(workspace, 'notes.md')])
      expect(second!.paths).toEqual([join(workspace, 'made')])
      expect(second!.notRestorable).toEqual([`${workspace}/made/a\\b`])
      // Named once, by its place in the folder alone, when a command's checkpoint meets it (Slice F2, item 3).
      const named = warn.mock.calls.filter(([message]) => message.startsWith('History leaves out')).map(([, fields]) => fields)
      expect(named).toEqual([{ name: 'made/a\\b' }])
      await expect(history.restore(second!.id)).rejects.toThrow('Restore conflict: a directory holds a name Buckle would read as another path, which history does not capture')
      expect(readFileSync(`${workspace}/made/a\\b`, 'utf8')).toBe('made')
      expect(readFileSync(`${workspace}/inside\\..\\..\\x`, 'utf8')).toBe('literal')
    } finally {
      warn.mockRestore()
      await history.close()
    }
  })

  it('is still refused by the shell\'s hidden-path scan and the staged editor, which name it the same way', async () => {
    const root = scratch()
    const workspace = join(root, 'workspace')
    mkdirSync(join(workspace, 'sub'), { recursive: true })
    writeFileSync(`${workspace}/sub/a\\b`, '')
    await expect(collectShellHiddenPaths({ roots: [workspace], protectedPaths: [], signal: AbortSignal.timeout(5_000) })).rejects.toThrow('The workspace holds sub/a\\b, a name with a backslash, which Buckle cannot hide from shell commands')
    const files = createWorkbenchFiles({ sourceRoot: workspace, directory: join(root, 'workbenches'), maxBytes: 1_000_000, protectedRoots: () => [], authorizePath: () => true, ripgrep: () => null })
    expect(() => files.prepare('staged')).toThrow('The workspace holds sub/a\\b, a name Buckle would read as another path, which the staged editor cannot judge')
  })
})

/** Runs `run` with the process's working directory at `directory`, where a path pathe reads as a drive would be opened. */
function within<T>(directory: string, run: () => T): T {
  const cwd = process.cwd()
  process.chdir(directory)
  try { return run() } finally { process.chdir(cwd) }
}

// pathe resolves `C:/` to `/C:`, whose root is `/`, so a workspace at a drive's root held none of its own files, and
// `C:/` held `D:/`: a deny there was skipped, a program planted on the drive was trusted, and a state directory on it
// was not inside the workspace.
describe('a drive\'s root on Windows, imitated', () => {
  it('holds every path on its drive and none on another', () => {
    expect(isInside('C:/', 'C:/x', 'win32')).toBe(true)
    expect(isInside('C:\\', 'C:\\x\\y', 'win32')).toBe(true)
    expect(isInside('C:/', 'C:/', 'win32')).toBe(true)
    expect(isInside('C:/', 'D:/', 'win32')).toBe(false)
    expect(isInside('C:/', 'D:/x', 'win32')).toBe(false)
    expect(isInside('C:/x', 'C:/', 'win32')).toBe(false)
    expect(isInsideComparable('c:/', 'C:/Users/x', true, 'win32')).toBe(true)
    expect(workspaceHolds('D:/', 'D:/state', 'win32')).toBe(true)
  })

  it('is never named /C:, and a climb stops at it, by any path helper', () => {
    const named = [
      resolvePath('C:/'), resolvePath('C:\\'), resolvePath('c:/x/..'), resolvePath('C:/..'), resolvePath('C:/ws', '../..'), resolvePath('C:/ws', '..\\..\\x'),
      nativePath('C:\\', 'win32'), nativePath('C:\\x\\..', 'win32'), nativePath('C:\\..\\x', 'win32'), nativePath('C:/x/../..', 'win32'),
      typedPath('C:\\', 'win32'), typedPath('D:', 'win32'), pathRoot('/C:', 'win32'), parentDirectory('C:/x'), ...descent('C:/x'),
      createPathView({ root: 'C:\\', mount: null, platform: 'win32' }).root, createPathView({ root: 'C:/ws', mount: null, platform: 'win32' }).resolve('..\\..\\..'),
      createPathView({ root: 'D:/ws', mount: null, scratchRoots: ['C:\\'], platform: 'win32' }).scratchRoots[0]!,
    ]
    expect(named.filter(path => /^\/[A-Za-z]:/.test(path))).toEqual([])
    expect(named.slice(0, 6)).toEqual(['C:/', 'C:/', 'C:/', 'C:/', 'C:/', 'C:/x'])
    expect(createPathView({ root: 'D:\\', mount: null, platform: 'win32' }).resolve('src\\a.ts')).toBe('D:/src/a.ts')
  })

  it('meets a deny on the drive, which a grant on a folder does not lift, and reads the drive\'s files as inside', () => {
    // realpathSync.native answers as Windows would: the drive exists, nothing below it does.
    vi.spyOn(realpathSync, 'native').mockImplementation(((path: string) => {
      if (path === 'D:/') return 'D:\\'
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    }) as typeof realpathSync.native)
    try {
      const policy = WorkspacePolicySchema.parse({ ...emptyWorkspacePolicy(), filesystem: { rules: [{ path: 'secret', read: 'deny' }] } })
      const rule = createFilesystemPolicyRule({ root: 'D:/', policy, platform: 'win32' })
      const effect = { kind: 'read_path' as const, path: 'D:/secret/key.txt', directory: 'D:/secret' }
      expect(rule.evaluate({ tool: 'fs_read', effect, grants: { subjectsFor: () => ['D:/secret'] } })).toMatchObject({ kind: 'deny', rule: 'filesystem_policy' })
      const readScope = createReadScopeRule({ paths: createPathView({ root: 'D:/', mount: null, platform: 'win32' }) })
      expect(readScope.evaluate({ tool: 'fs_read', effect: { kind: 'read_path', path: 'D:/src/a.ts', directory: 'D:/src' }, grants: { subjectsFor: () => [] } })).toEqual({ kind: 'allow' })
    } finally { vi.restoreAllMocks() }
  })

  it('refuses a program found anywhere on a drive that is an untrusted root', () => {
    expect(resolveProgram('rg', { untrustedRoots: rootsOf('workspace', ['D:/']), lookup: () => 'D:\\tools\\rg.exe', platform: 'win32' })).toMatchObject({ path: null, untrusted: true })
    expect(resolveProgram('rg', { untrustedRoots: rootsOf('workspace', ['D:/']), lookup: () => 'C:\\tools\\rg.exe', platform: 'win32' })).toEqual({ path: 'C:/tools/rg.exe', argv0: 'C:/tools/rg.exe', args: [] })
  })

  // pathe takes `//./ws` for a relative path, so `C://./ws/secret/k.txt` was resolved from the working directory: from
  // `C:\ws` the agent's view judged `C:/ws/ws/secret/k.txt`, past a deny on `secret`, while Windows, and git handed the
  // string as typed, open `C:\ws\secret\k.txt`.
  it('keeps every separator after a drive one, so a drive followed by two and a dot stays on that drive', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('C:\\ws')
    vi.spyOn(realpathSync, 'native').mockImplementation(((path: string) => {
      if (path === 'C:/') return 'C:\\'
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    }) as typeof realpathSync.native)
    try {
      const view = createPathView({ root: 'C:/ws', mount: null, platform: 'win32' })
      for (const named of ['C://./ws/secret/k.txt', 'C:\\\\.\\ws\\secret\\k.txt', 'C:///ws//secret/./k.txt', 'C:\\\\\\ws\\secret\\k.txt', 'C:/./../ws/secret/k.txt']) {
        expect(nativePath(named, 'win32')).toBe('C:/ws/secret/k.txt')
        expect(resolvePath(withForwardSlashes(named, 'win32'))).toBe('C:/ws/secret/k.txt')
        expect(view.resolve(named)).toBe('C:/ws/secret/k.txt')
      }
      const policy = WorkspacePolicySchema.parse({ ...emptyWorkspacePolicy(), filesystem: { rules: [{ path: 'secret', read: 'deny' }] } })
      expect(filesystemPathDecision({ root: 'C:/ws', path: view.resolve('C://./ws/secret/k.txt'), policy, operation: 'read', platform: 'win32' })).toBe('deny')
      expect(nativePath('C://./.', 'win32')).toBe('C:/')
      expect(nativePath('D://./x', 'win32')).toBe('D:/x')
      expect(resolvePath('D://./x')).toBe('D:/x')
      expect(resolvePath('C://./ws', '..', '..')).toBe('C:/')
    } finally { vi.restoreAllMocks() }
  })
})

describe('a whole drive as a Buckle root on Windows, imitated', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
  const refused = `a whole drive cannot be a Buckle root; use a folder`

  it('is what isDriveRoot names, in any spelling, and only on Windows', () => {
    expect(WHOLE_DRIVE).toBe(refused)
    for (const drive of ['C:/', 'C:\\', 'c:/x/..', '/', typedPath('c:', 'win32'), 'C://./.', 'C:\\\\\\']) expect(isDriveRoot(drive, 'win32')).toBe(true)
    for (const folder of ['C:/x', 'C:\\Users\\me', '/x']) expect(isDriveRoot(folder, 'win32')).toBe(false)
    expect(isDriveRoot('/', 'linux')).toBe(false)
  })

  // `.` and `..` are folded first, so `C:\x\..` is the drive's root. A spelling with a name that ends in a dot or a space,
  // such as `C:\ ` or `C:\x\.. ` (`.. ` is no `..`), is refused before it is judged at all, wherever it would land.
  it('is named once `.` and `..` are folded, and a name that ends in a dot or a space is refused first', () => {
    for (const drive of ['C:/.', 'C:\\x\\..', typedPath('E:\\x.\\..', 'win32')]) expect(isDriveRoot(drive, 'win32')).toBe(true)
    expect(() => stateDirectoryOf({ BUCKLE_STATE_DIR: 'E:\\x.\\..' }, 'win32')).toThrow(`BUCKLE_STATE_DIR is E:/: ${refused}`)
    for (const named of ['C:\\ ', 'C:\\...', 'C:\\. .', 'D:\\x\\..\\ .', '\\ ', 'D:\\.. .', 'C:\\x.', 'C:\\x\\.. ']) {
      expect(() => typedPath(named, 'win32'), named).toThrow(/holds a name that ends in a dot or a space/)
    }
    expect(() => stateDirectoryOf({ BUCKLE_STATE_DIR: 'E:\\ ' }, 'win32')).toThrow(/E:\\ {2}holds a name that ends in a dot or a space/)
    expect(() => clientDirectory({ BUCKLE_CLIENT_DIR: 'D:\\.. .' }, 'win32')).toThrow(/D:\\\.\. \. holds a name that ends in a dot or a space/)
  })

  it('is refused as the state directory or the client directory where it really is, through a link', () => {
    const link = join(scratch(), 'drive')
    // Linux's root stands for the drive a link on Windows leads to: both are a root with nothing above it.
    symlinkSync('/', link)
    expect(() => stateDirectoryOf({ BUCKLE_STATE_DIR: link }, 'win32')).toThrow(`BUCKLE_STATE_DIR is /: ${refused}`)
    expect(() => clientDirectory({ BUCKLE_CLIENT_DIR: link }, 'win32')).toThrow(`BUCKLE_CLIENT_DIR is /: ${refused}`)
    expect(clientDirectory({ BUCKLE_CLIENT_DIR: join(link, 'client') }, 'win32')).toBe(join(link, 'client'))
  })

  it('is refused at config load as the workspace root, the working directory, a scratch root, or the state directory', () => {
    const root = scratch()
    const state = join(scratch(), 'state')
    expect(() => configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: 'D:\\', BUCKLE_STATE_DIR: state }, 'win32')).toThrow(`BUCKLE_WORKSPACE_ROOT is D:/: ${refused}`)
    expect(() => configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: root, BUCKLE_STATE_DIR: 'E:\\' }, 'win32')).toThrow(`BUCKLE_STATE_DIR is E:/: ${refused}`)
    expect(() => configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: root, BUCKLE_STATE_DIR: state, BUCKLE_SCRATCH_ROOTS: `${join(root, 'scratch')},F:\\` }, 'win32')).toThrow(`BUCKLE_SCRATCH_ROOTS is F:/: ${refused}`)
    expect(() => stateDirectoryOf({ BUCKLE_STATE_DIR: 'C:/' }, 'win32')).toThrow(refused)
    expect(configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: root, BUCKLE_STATE_DIR: state }, 'win32').cwd).toBe(root)
    // Buckle started in D:\ with no BUCKLE_WORKSPACE_ROOT serves the directory it started in.
    vi.spyOn(process, 'cwd').mockReturnValue('D:\\')
    expect(() => configFromEnvironment({ BUCKLE_STATE_DIR: state }, 'win32')).toThrow(`The working directory, the workspace root while BUCKLE_WORKSPACE_ROOT is unset, is D:/: ${refused}`)
  })

  it('is refused as the client directory, and by init as the workspace folder', async () => {
    expect(() => clientDirectory({ BUCKLE_CLIENT_DIR: 'D:\\' }, 'win32')).toThrow(`BUCKLE_CLIENT_DIR is D:/: ${refused}`)
    let printed = ''
    vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { printed += String(chunk); return true })
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const prompt = { interactive: false, question: async () => '', say: () => {}, close: () => {} }
    const out = join(scratch(), 'buckle.env')
    expect((await runInit(['--root', 'D:\\', '--out', out, '--yes'], prompt, { platform: 'win32' })).exitCode).toBe(1)
    expect(printed).toBe(`The workspace folder is D:/: ${refused}.\n`)
    expect(existsSync(out)).toBe(false)
  })

  it('is refused when a workspace is registered, and offered as no choice; a mount names no drive at all', async () => {
    const root = scratch()
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: root, BUCKLE_STATE_DIR: join(scratch(), 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs' })
    await workspacesOf(config)
    const manager = await workspacesOf(config, { platform: 'win32' })
    await expect(manager.create({ id: 'drive', name: 'Drive', dir: 'D:\\', policy: emptyWorkspacePolicy() })).rejects.toThrow(`Workspace folder D:\\: ${refused}`)
    expect(manager.eligibility('E:/')).toEqual({ selectable: false, reason: `Workspace folder E:/: ${refused}` })
    expect(manager.list().map(workspace => workspace.id)).toEqual([config.workspaceId])
    for (const mount of ['C:/', 'C:\\', '/C:', '/c:/x', 'D:']) expect(MountPathSchema.safeParse(mount).success).toBe(false)
  })
})

// pathe's join folds `/` and `c:` into the drive `c:/`, and its resolve climbs from a workspace to `/c:`, a folder at the
// root on Linux and macOS: a walk then lstat'ed `c:/` in the process's working directory, and judged a link to `/c:`
// as `C:/` while beneath created `C:` at the filesystem root. Each is now walked as the kernel walks it and refused.
describe('a drive-shaped name reached by a climb or a link, on Linux', () => {
  /** A workspace four levels down, and a working directory holding `C:` and `c:` folders a misread path would reach. */
  function scene() {
    const root = scratch()
    const workspace = join(root, 'a', 'b', 'c', 'ws')
    mkdirSync(workspace, { recursive: true })
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(join(elsewhere, 'C:'), { recursive: true })
    mkdirSync(join(elsewhere, 'c:'), { recursive: true })
    writeFileSync(join(elsewhere, 'C:', 'x'), 'misread')
    return { workspace, elsewhere, climb: '../'.repeat(workspace.split('/').length + 2) }
  }

  it('refuses a climb onto /c:, from the agent\'s view and from a typed path', () => {
    const { workspace, elsewhere, climb } = scene()
    const view = createPathView({ root: workspace, mount: null, platform: 'linux' })
    for (const named of [`${climb}c:`, `${climb}c:/x`, `${climb}C:/x`, `sub/${climb}c:`]) {
      expect(() => view.resolve(named)).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED', message: expect.stringContaining('lands on a drive letter') }))
    }
    within(elsewhere, () => {
      expect(() => typedPath(`${climb}c:`, 'linux')).toThrow(/lands on a drive letter/)
      expect(() => typedPath(`${climb}C:/x`, 'linux')).toThrow(/lands on a drive letter/)
    })
    expect(view.resolve('sub/c:')).toBe(`${workspace}/sub/c:`)
  })

  it('refuses a workspace link to /c:, /C:/x, or /c:/x, and a path through one, wherever the process runs', () => {
    const { workspace, elsewhere } = scene()
    const links = { L1: '/c:', L2: '/C:/x', L3: '/c:/x' }
    for (const [name, target] of Object.entries(links)) symlinkSync(target, join(workspace, name))
    for (const directory of [workspace, elsewhere]) {
      within(directory, () => {
        for (const path of ['L1', 'L2', 'L3', 'L1/x', 'L1/new/file.txt']) {
          expect(() => resolveTarget(join(workspace, path))).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED', message: `${join(workspace, path)} lands on a drive letter once \`.\`, \`..\`, and repeated slashes are folded, which Buckle reads as a Windows drive, so Buckle refuses it rather than read it as another path` }))
        }
      })
    }
    expect(existsSync(join(workspace, 'C:'))).toBe(false)
  })

  it('walks to a folder named c: at the root as that folder, and refuses it there', () => {
    const { elsewhere } = scene()
    within(elsewhere, () => {
      for (const path of ['/c:', '/C:', '/c:/x', '/C:/x', '/c:/new/file.txt']) {
        expect(() => resolveTarget(path)).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }))
      }
    })
    expect(childPath('/', 'c:')).toBe('/c:')
    expect(childPath('/ws', 'c:')).toBe('/ws/c:')
    expect(childPath('C:/', 'x')).toBe('C:/x')
    expect(childPath('//server/share/', 'x')).toBe('//server/share/x')
  })

  it('leaves out of a content search from / a file rg lists under /c:, never opening the one the working directory holds', async () => {
    const { elsewhere } = scene()
    const judged: string[] = []
    const answer = (stdout: string) => ({ exitCode: 0, signal: null, stdout, stderr: '', truncated: false, timedOut: false })
    const match = JSON.stringify({ type: 'match', data: { lines: { text: 'misread\n' }, line_number: 1, submatches: [{ start: 0, end: 7 }] } })
    const cwd = process.cwd()
    // Async, so the working directory is set by hand for the whole search rather than by within().
    process.chdir(elsewhere)
    try {
      const found = await searchContent({
        args: searchInput.parse({ pattern: 'misread', path: '/' }), paths: createPathView({ root: '/', mount: null }), ripgrep: { path: '/usr/bin/rg', argv0: '/usr/bin/rg', args: [] }, protectedRoots: [], platform: 'linux',
        runProcess: async request => answer(request.args[0] === '--files' ? './C:/x\0' : `${match}\n`),
        timeoutMs: 5_000, signal: AbortSignal.timeout(5_000), authorizeRead: async path => { judged.push(path); return true },
      })
      expect(found).toEqual({ matches: [], truncated: false, excludedFiles: 1 })
      expect(judged).toEqual([])
    } finally { process.chdir(cwd) }
  })
})

// pathe resolved a rule's `c:/secret.txt` from the workspace to the drive `C:/`, whose real path does not exist on Linux,
// so the rule failed every file call in the workspace. Its names are now a path under the root.
describe('a workspace rule named like a drive, on Linux', () => {
  it('covers the folder c: in the workspace, and leaves every other call alone, wherever the process runs', async () => {
    const root = scratch()
    const workspace = join(root, 'ws')
    mkdirSync(join(workspace, 'c:'), { recursive: true })
    writeFileSync(join(workspace, 'c:', 'secret.txt'), 'secret')
    const policy = WorkspacePolicySchema.parse({ ...emptyWorkspacePolicy(), filesystem: { rules: [{ path: 'c:/secret.txt', read: 'deny' }, { path: 'C:/missing/x', write: 'deny' }] } })
    // The process runs where no `C:` is, so pathe's `C:/` had no real path at all.
    within(root, () => {
      expect(filesystemPathDecision({ root: workspace, path: join(workspace, 'c:', 'secret.txt'), policy, operation: 'read', platform: 'linux' })).toBe('deny')
      expect(filesystemPathDecision({ root: workspace, path: join(workspace, 'C:', 'missing', 'x'), policy, operation: 'write', platform: 'linux' })).toBe('deny')
      expect(filesystemPathDecision({ root: workspace, path: join(workspace, 'other.txt'), policy, operation: 'read', platform: 'linux' })).toBe('inherit')
    })
    const projected = await projectFilesystemSandbox({ root: workspace, policy, platform: 'linux' })
    expect(projected.hiddenFiles).toEqual([join(workspace, 'c:', 'secret.txt')])
    expect(projected.readOnlyWorkspacePaths).toEqual([workspace])
  })
})
