import { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { executableCandidates, findExecutable, isPathReference, resolveProgram, rootsOf, trustedSearchPath, type UntrustedRoots } from '../common/domain/executable.js'

const root = mkdtempSync(join(tmpdir(), 'buckle-exec-'))

function writeExecutable(name: string): string {
  const path = join(root, name)
  writeFileSync(path, '#!/bin/sh\nexit 0\n')
  chmodSync(path, 0o755)
  return path
}

describe('findExecutable', () => {
  it('finds an executable file on PATH', () => {
    const path = writeExecutable('buckle-real-tool')
    expect(findExecutable('buckle-real-tool', { PATH: root }, 'linux')).toBe(path)
  })

  it('ignores a file on PATH that is not executable', () => {
    writeFileSync(join(root, 'buckle-not-executable'), 'text\n')
    chmodSync(join(root, 'buckle-not-executable'), 0o644)
    expect(findExecutable('buckle-not-executable', { PATH: root }, 'linux')).toBeNull()
  })

  it('ignores a directory that happens to carry the execute bit', () => {
    mkdirSync(join(root, 'buckle-directory'), { recursive: true })
    expect(findExecutable('buckle-directory', { PATH: root }, 'linux')).toBeNull()
  })

  it('returns null rather than throwing when PATH is unset', () => {
    expect(findExecutable('buckle-real-tool', {}, 'linux')).toBeNull()
  })

  it('checks an explicit path directly instead of scanning PATH', () => {
    const path = writeExecutable('buckle-explicit-tool')
    expect(findExecutable(path, { PATH: '' }, 'linux')).toBe(path)
  })
})

// The validator's configured path may lie outside every workspace: a refusal the agent reads names it by its setting.
describe('resolveProgram', () => {
  it('names a refused program by what it is shown as, never by its path or a link\'s target', () => {
    const at = mkdtempSync(join(root, 'shown-'))
    const shownAs = 'The validator BUCKLE_ENV_VALIDATOR_COMMAND names'
    const executable = (path: string) => { writeFileSync(path, '#!/bin/sh\nexit 0\n'); chmodSync(path, 0o755); return path }
    for (const directory of ['owner-private\\tools', 'real\\secret', 'opt']) mkdirSync(join(at, directory))
    const backslashed = executable(join(at, 'owner-private\\tools', 'varlock'))
    symlinkSync(executable(join(at, 'real\\secret', 'varlock')), join(at, 'opt', 'varlock'))
    for (const program of [backslashed, join(at, 'opt', 'varlock')]) {
      const refused = resolveProgram(program, { untrustedRoots: [], shownAs, platform: 'linux' })
      expect(refused, program).toMatchObject({ path: null })
      const reason = refused.path === null ? refused.reason : ''
      expect(reason.startsWith(shownAs), reason).toBe(true)
      expect(reason, reason).not.toMatch(/owner-private|secret|varlock|\//)
    }
  })
})

describe('isPathReference', () => {
  it('treats a forward slash as a separator everywhere', () => {
    expect(isPathReference('/usr/bin/git', 'linux')).toBe(true)
    expect(isPathReference('C:/tools/agent-browser.exe', 'win32')).toBe(true)
  })

  it('treats a backslash as a separator only on Windows', () => {
    expect(isPathReference('D:\\tools\\agent-browser.exe', 'win32')).toBe(true)
    expect(isPathReference('weird\\name', 'linux')).toBe(false)
  })

  it('treats a bare binary name as a PATH lookup', () => {
    expect(isPathReference('git', 'win32')).toBe(false)
    expect(isPathReference('git', 'linux')).toBe(false)
  })
})

describe('executableCandidates', () => {
  it('leaves a POSIX name alone', () => {
    expect(executableCandidates('git', 'linux')).toEqual(['git'])
  })

  it('suffixes a bare Windows name, because git is stored as git.exe', () => {
    expect(executableCandidates('git', 'win32')).toEqual(['git.exe', 'git.com'])
  })

  it('keeps an explicit Windows extension as written', () => {
    expect(executableCandidates('agent-browser.exe', 'win32')).toEqual(['agent-browser.exe'])
  })

  it('matches an extension case insensitively', () => {
    expect(executableCandidates('AGENT-BROWSER.EXE', 'win32')).toEqual(['AGENT-BROWSER.EXE'])
  })

  it('never offers a batch file, which Node refuses to spawn without a shell', () => {
    const candidates = executableCandidates('agent-browser', 'win32')
    expect(candidates.some(candidate => candidate.endsWith('.cmd'))).toBe(false)
    expect(candidates.some(candidate => candidate.endsWith('.bat'))).toBe(false)
  })
})

// A program Buckle runs on the host inherits PATH: a trusted script that starts `#!/usr/bin/env node` looked `node` up
// where `npx` and `pnpm exec` start it, in a workspace's node_modules/.bin, and ran the agent's.
describe('trustedSearchPath', () => {
  const base = mkdtempSync(join(root, 'search-path-'))
  const workspace = join(base, 'ws')
  const tools = join(base, 'tools')
  for (const directory of [join(workspace, 'node_modules', '.bin'), join(workspace, 'tools'), tools]) mkdirSync(directory, { recursive: true })
  symlinkSync(join(workspace, 'tools'), join(base, 'linked-tools'))
  symlinkSync(join(workspace, 'tools'), join(base, 'hop'))
  symlinkSync(join(base, 'hop'), join(base, 'through-hop'))
  const roots = { untrustedRoots: rootsOf('workspace', [workspace]) }

  it('keeps the entries outside every root, in order, as their real paths, and drops each one inside a root, as named, where it leads, or on the way', () => {
    const entries = [join(workspace, 'node_modules', '.bin'), '/usr/bin', join(base, 'linked-tools'), tools, join(base, 'through-hop', 'sub'), '/bin']
    expect(trustedSearchPath(entries.join(':'), roots, 'linux')).toBe([realpathSync('/usr/bin'), tools, realpathSync('/bin')].join(':'))
  })

  it('drops an empty or relative entry, which names a folder in whichever directory a program starts in', () => {
    expect(trustedSearchPath(['', '.', 'bin', './node_modules/.bin', '/usr/bin'].join(':'), roots, 'linux')).toBe(realpathSync('/usr/bin'))
  })

  // The child's kernel walks an entry again, a link first and then a `..` (realpathSync.native walks as it does): an entry
  // judged as folded text but handed over as written ran the node an agent planted.
  describe('hands the child the path it judged, never the entry as written', () => {
    function fixture(): { base: string; workspace: string; roots: UntrustedRoots } {
      const fixtureBase = mkdtempSync(join(root, 'search-shapes-'))
      const fixtureWorkspace = join(fixtureBase, 'ws')
      mkdirSync(fixtureWorkspace)
      return { base: fixtureBase, workspace: fixtureWorkspace, roots: { untrustedRoots: rootsOf('workspace', [fixtureWorkspace]) } }
    }
    const directories = (...paths: string[]) => { for (const path of paths) mkdirSync(path, { recursive: true }) }

    it('an agent link and a `..` in the entry: the folded place, never the workspace folder the spelling reaches', () => {
      const { base: at, workspace: ws, roots: wsRoots } = fixture()
      directories(join(ws, 'a', 'b'), join(ws, 'tools', 'bin'), join(at, 'tools', 'bin'))
      symlinkSync(join(ws, 'a', 'b'), join(ws, 'lnk'))
      const entry = `${ws}/lnk/../../tools/bin`
      expect(realpathSync.native(entry)).toBe(realpathSync(join(ws, 'tools', 'bin')))
      expect(trustedSearchPath(entry, wsRoots, 'linux')).toBe(realpathSync(join(at, 'tools', 'bin')))
    })

    it('a link outside every root that leads into one, then a `..`: the folded place outside', () => {
      const { base: at, workspace: ws, roots: wsRoots } = fixture()
      directories(join(ws, 'sub'), join(ws, 'bin'), join(at, 'out', 'bin'))
      symlinkSync(join(ws, 'sub'), join(at, 'out', 'lnkout'))
      const entry = `${at}/out/lnkout/../bin`
      expect(realpathSync.native(entry)).toBe(realpathSync(join(ws, 'bin')))
      expect(trustedSearchPath(entry, wsRoots, 'linux')).toBe(realpathSync(join(at, 'out', 'bin')))
    })

    it('an entry through the reading process\'s own folders is dropped, as it names the child\'s places, not Buckle\'s', () => {
      const { roots: wsRoots } = fixture()
      const entries = ['/proc/self/cwd/node_modules/.bin', '/proc/thread-self/cwd/bin', '/dev/fd/3', '/proc/self/../self/root/usr/bin']
      expect(trustedSearchPath(entries.join(':'), wsRoots, 'linux')).toBe('')
    })

    it('an owner link whose target passes through a root: its real path, which a folder swapped in the root no longer moves', () => {
      const { base: at, workspace: ws, roots: wsRoots } = fixture()
      directories(join(ws, 'a'), join(ws, 'evil', 'x', 'y'), join(ws, 'evil', 'trusted', 'bin'), join(at, 'trusted', 'bin'), join(at, 'owner'))
      symlinkSync('../ws/a/../../trusted/bin', join(at, 'owner', 'tools'))
      const judged = trustedSearchPath(join(at, 'owner', 'tools'), wsRoots, 'linux')
      expect(judged).toBe(realpathSync(join(at, 'trusted', 'bin')))
      renameSync(join(ws, 'a'), join(ws, 'a.old'))
      symlinkSync(join(ws, 'evil', 'x', 'y'), join(ws, 'a'))
      expect(realpathSync.native(join(at, 'owner', 'tools'))).toBe(realpathSync(join(ws, 'evil', 'trusted', 'bin')))
      expect(realpathSync(judged)).toBe(realpathSync(join(at, 'trusted', 'bin')))
      expect(trustedSearchPath(join(at, 'owner', 'tools'), wsRoots, 'linux')).toBe('')
    })

    it('on Windows the folded place, in the native spelling', () => {
      const windowsRoots = { untrustedRoots: rootsOf('workspace', ['C:/ws']) }
      expect(trustedSearchPath('C:\\Tools\\x\\..\\bin;C:\\ws\\a\\..\\..\\Tools', windowsRoots, 'win32')).toBe('C:\\Tools\\bin;C:\\Tools')
    })
  })

  it('keeps nothing while the roots are unknown', () => {
    expect(trustedSearchPath('/usr/bin:/bin', { ...roots, rootsUnknown: 'the workspace registry cannot be read' }, 'linux')).toBe('')
  })

  it('reads Windows\' separator, keeps only entries on a drive, and compares as the disk does', () => {
    const windowsRoots = { untrustedRoots: rootsOf('workspace', ['C:/ws']) }
    expect(trustedSearchPath('C:\\WS\\node_modules\\.bin;C:\\Windows\\system32;\\bin;tools;D:\\Tools', windowsRoots, 'win32')).toBe('C:\\Windows\\system32;D:\\Tools')
  })
})
