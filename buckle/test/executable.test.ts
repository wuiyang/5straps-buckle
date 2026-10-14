import { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { executableCandidates, findExecutable, findProgram, isPathReference, MAX_SHIM_BYTES, npmGlobalBin, ownerPlaces, resolveProgram, rootsOf, trustedSearchPath, type UntrustedRoots } from '../common/domain/executable.js'

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

  it('never offers a batch file, which Node refuses to spawn without a shell; a shim is read apart (firstShim)', () => {
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

// npm installs a command on Windows as a batch shim only, which Node cannot spawn without cmd.exe, and Buckle never
// runs cmd.exe. The shim is read as text, and the program it starts is judged and run in its place. Windows is
// imitated through the platform the lookup takes; the files are real, under a scratch folder.
describe('a Windows shim, imitated', () => {
  const base = mkdtempSync(join(root, 'shims-'))
  let count = 0
  /** A fresh npm prefix: `<prefix>/<name>.cmd` holding `text`, and each of `files` beneath the prefix. */
  function prefix(input: { shim: string; files?: string[]; name?: string }) {
    const at = join(base, `prefix-${++count}`)
    const name = input.name ?? 'agent-browser'
    mkdirSync(at, { recursive: true })
    for (const file of input.files ?? []) {
      mkdirSync(join(at, file, '..'), { recursive: true })
      writeFileSync(join(at, file), '')
    }
    writeFileSync(join(at, `${name}.cmd`), input.shim)
    return { at, shim: join(at, `${name}.cmd`) }
  }
  const resolve = (shim: string, untrustedRoots: UntrustedRoots['untrustedRoots'] = []) => resolveProgram('agent-browser', { untrustedRoots, lookup: () => shim, platform: 'win32' })
  const refusal = (file: string, why: string) => ({ path: null, reason: `agent-browser was found on PATH as ${file}, ${why}, so Buckle does not run it`, untrusted: false, shim: { file, place: 'on PATH', why } })

  it('reads npm\'s own shim as Buckle\'s Node running the script, never the node.exe its probe names', () => {
    const { at, shim } = prefix({ shim: NPM_SHIM('node', 'node_modules\\agent-browser\\bin\\agent-browser.js'), files: ['node.exe', 'node_modules/agent-browser/bin/agent-browser.js'] })
    expect(resolve(shim)).toEqual({ path: process.execPath, argv0: process.execPath, args: [join(at, 'node_modules/agent-browser/bin/agent-browser.js')] })
  })

  it('reads pnpm\'s shim, whose two lines name the same script', () => {
    const { at, shim } = prefix({ shim: PNPM_SHIM('global\\5\\node_modules\\agent-browser\\bin\\agent-browser.js'), files: ['global/5/node_modules/agent-browser/bin/agent-browser.js'] })
    expect(resolve(shim)).toEqual({ path: process.execPath, argv0: process.execPath, args: [join(at, 'global/5/node_modules/agent-browser/bin/agent-browser.js')] })
  })

  it('runs a script the owner names by its path with Buckle\'s own Node on Windows, as a program elsewhere', () => {
    const { at } = prefix({ shim: '', files: ['node_modules/agent-browser/bin/agent-browser.js'] })
    const script = join(at, 'node_modules/agent-browser/bin/agent-browser.js')
    expect(resolveProgram(script, { untrustedRoots: [], platform: 'win32', places: [] })).toEqual({ path: process.execPath, argv0: process.execPath, args: [script] })
    expect(resolveProgram(script, { untrustedRoots: rootsOf('workspace', [at]), platform: 'win32', places: [] })).toMatchObject({ path: null, untrusted: true })
    expect(resolveProgram(script, { untrustedRoots: [], platform: 'linux', places: [] })).toMatchObject({ path: null, reason: `${script} is not installed on this node` })
  })

  it('reads the shim agent-browser\'s install writes as the native .exe it starts', () => {
    const exe = 'node_modules/agent-browser/bin/agent-browser-win32-x64.exe'
    const { at, shim } = prefix({ shim: AGENT_BROWSER_SHIM, files: [exe] })
    expect(resolve(shim)).toEqual({ path: join(at, exe), argv0: join(at, exe), args: [] })
  })

  it('refuses a shim that runs /bin/sh, names no path beside itself, sets no dp0, or names two programs', () => {
    const tool = 'node_modules\\agent-browser\\bin\\agent-browser'
    const shapes = [
      NPM_SHIM('/bin/sh', tool),
      '@ECHO off\r\nnode "C:\\tools\\agent-browser.js" %*\r\n',
      '@ECHO off\r\n"%dp0%\\agent-browser.exe" %*\r\n',
      '@ECHO off\r\n"%~dp0one.exe" %*\r\n"%~dp0two.exe" %*\r\n',
      '@ECHO off\r\n"%~dp0%TOOL%\\agent-browser.exe" %*\r\n',
      '@ECHO off\r\n"%~dp0agent-browser.ps1" %*\r\n',
    ]
    for (const text of shapes) {
      const { shim } = prefix({ shim: text, files: ['node_modules/agent-browser/bin/agent-browser', 'agent-browser.exe', 'one.exe', 'two.exe'] })
      expect(resolve(shim), text).toEqual(refusal('agent-browser.cmd', 'a shim Buckle cannot read'))
    }
  })

  it('refuses a shim whose program is not there', () => {
    const { shim } = prefix({ shim: AGENT_BROWSER_SHIM })
    expect(resolve(shim)).toEqual(refusal('agent-browser.cmd', 'a shim whose program is not there'))
  })

  it('judges a `..` climb from the shim\'s folder as every path is: run outside every root, refused into a workspace', () => {
    const { at, shim } = prefix({ shim: '@ECHO off\r\n"%~dp0..\\tools\\agent-browser.exe" %*\r\n' })
    const tools = join(at, '..', 'tools')
    mkdirSync(tools, { recursive: true })
    writeFileSync(join(tools, 'agent-browser.exe'), '')
    expect(resolve(shim)).toEqual({ path: join(tools, 'agent-browser.exe'), argv0: join(tools, 'agent-browser.exe'), args: [] })
    expect(resolve(shim, rootsOf('workspace', [tools]))).toEqual({ path: null, reason: 'agent-browser is found in or through a workspace of this node, where an agent can write, so Buckle does not run it', untrusted: true })
  })

  it('refuses a script a shim names through a link into a workspace, and a shim inside one', () => {
    const workspace = mkdtempSync(join(base, 'ws-'))
    writeFileSync(join(workspace, 'agent-browser.js'), '')
    const { at, shim } = prefix({ shim: NPM_SHIM('node', 'node_modules\\agent-browser\\bin\\agent-browser.js') })
    mkdirSync(join(at, 'node_modules', 'agent-browser'), { recursive: true })
    symlinkSync(workspace, join(at, 'node_modules', 'agent-browser', 'bin'))
    const untrusted = { path: null, reason: 'agent-browser is found in or through a workspace of this node, where an agent can write, so Buckle does not run it', untrusted: true }
    expect(resolve(shim, rootsOf('workspace', [workspace]))).toEqual(untrusted)
    writeFileSync(join(workspace, 'agent-browser.cmd'), AGENT_BROWSER_SHIM)
    expect(resolve(join(workspace, 'agent-browser.cmd'), rootsOf('workspace', [workspace]))).toEqual(untrusted)
  })

  it('reads at most 64 KiB: a shim of that size is read, one byte more is refused', () => {
    const exe = 'node_modules/agent-browser/bin/agent-browser-win32-x64.exe'
    const padded = (size: number) => `${AGENT_BROWSER_SHIM}REM ${'x'.repeat(size - AGENT_BROWSER_SHIM.length - 6)}\r\n`
    expect(padded(MAX_SHIM_BYTES)).toHaveLength(MAX_SHIM_BYTES)
    const fits = prefix({ shim: padded(MAX_SHIM_BYTES), files: [exe] })
    expect(resolve(fits.shim)).toMatchObject({ path: join(fits.at, exe) })
    const over = prefix({ shim: padded(MAX_SHIM_BYTES + 1), files: [exe] })
    expect(resolve(over.shim)).toEqual(refusal('agent-browser.cmd', 'a shim Buckle cannot read'))
  })

  it('reads a shim the owner names by its path, and names the setting rather than a place', () => {
    const exe = 'node_modules/agent-browser/bin/agent-browser-win32-x64.exe'
    const { at, shim } = prefix({ shim: AGENT_BROWSER_SHIM, files: [exe] })
    const shownAs = 'BUCKLE_AGENT_BROWSER_COMMAND'
    expect(resolveProgram(shim, { untrustedRoots: [], lookup: () => shim, platform: 'win32', shownAs })).toMatchObject({ path: join(at, exe), args: [] })
    const unread = prefix({ shim: '@ECHO off\r\nexit /b 1\r\n' })
    expect(resolveProgram(unread.shim, { untrustedRoots: [], lookup: () => unread.shim, platform: 'win32', shownAs })).toEqual({ path: null, reason: 'BUCKLE_AGENT_BROWSER_COMMAND is a shim Buckle cannot read, so Buckle does not run it', untrusted: false, shim: { file: 'agent-browser.cmd', place: null, why: 'a shim Buckle cannot read' } })
  })

  it('is read only on Windows: elsewhere a .cmd file is a program like any other', () => {
    const { shim } = prefix({ shim: AGENT_BROWSER_SHIM })
    expect(resolveProgram('agent-browser', { untrustedRoots: [], lookup: () => shim, platform: 'linux' })).toEqual({ path: shim, argv0: shim, args: [] })
  })
})

/** npm's cmd-shim for a bin whose first line is `#!/usr/bin/env <program>` or `#!<program>`, as npm 10 and 11 write it. */
function NPM_SHIM(program: string, target: string): string {
  return [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    `IF EXIST "%dp0%\\${program}.exe" (`, `  SET "_prog=%dp0%\\${program}.exe"`, ') ELSE (', `  SET "_prog=${program}"`, '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`, '',
  ].join('\r\n')
}

/** pnpm's shim for a node bin, which tries the node.exe beside it first. */
function PNPM_SHIM(target: string): string {
  return [
    '@SETLOCAL', '@IF NOT DEFINED NODE_PATH (', '  @SET "NODE_PATH=C:\\pnpm\\global\\5\\node_modules"', ') ELSE (', '  @SET "NODE_PATH=%NODE_PATH%;C:\\pnpm\\global\\5\\node_modules"', ')',
    '@IF EXIST "%~dp0\\node.exe" (', `  "%~dp0\\node.exe"  "%~dp0\\${target}" %*`, ') ELSE (', '  @SET PATHEXT=%PATHEXT:;.JS;=;%', `  node  "%~dp0\\${target}" %*`, ')', '',
  ].join('\r\n')
}

/** The shim agent-browser's postinstall writes over npm's (scripts/postinstall.js, fixWindowsShims). */
const AGENT_BROWSER_SHIM = '@ECHO off\r\n"%~dp0node_modules\\agent-browser\\bin\\agent-browser-win32-x64.exe" %*\r\n'

// The owner asked that Buckle find a program the way `where` would, past PATH: `npm i -g` puts it beside Buckle's
// own command, an nvm or volta Node's folder holds its global bin, and on Windows npm's is %APPDATA%\npm. No `where`
// or `which` is run; the same scan reaches these places after PATH, and judges what it finds as before.
describe('the places after PATH', () => {
  const at = mkdtempSync(join(root, 'places-'))
  const folder = (name: string) => { const path = join(at, name); mkdirSync(path, { recursive: true }); return path }
  const tool = (directory: string) => { const path = join(directory, 'buckle-placed-tool'); writeFileSync(path, '#!/bin/sh\nexit 0\n'); chmodSync(path, 0o755); return path }

  it('are the npm global bin holding Buckle\'s command, the folder of Buckle\'s Node, and on Windows %APPDATA%\\npm, in that order', () => {
    const prefix = folder('prefix')
    const entry = join(prefix, 'lib', 'node_modules', '@5straps', 'buckle', 'dist', 'main.js')
    mkdirSync(join(entry, '..'), { recursive: true })
    writeFileSync(entry, '')
    mkdirSync(join(prefix, 'bin'))
    symlinkSync(entry, join(prefix, 'bin', 'buckle'))
    const real = realpathSync(prefix)
    expect(ownerPlaces({ APPDATA: '/ignored' }, 'linux', { entry: join(prefix, 'bin', 'buckle'), execPath: '/opt/node/bin/node' })).toEqual([
      { directory: join(real, 'bin'), label: 'beside buckle' },
      { directory: '/opt/node/bin', label: 'beside node' },
    ])
    expect(ownerPlaces({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32', { entry: undefined, execPath: 'C:\\Program Files\\nodejs\\node.exe' })).toEqual([
      { directory: 'C:/Program Files/nodejs', label: 'beside node' },
      { directory: 'C:/Users/me/AppData/Roaming/npm', label: 'in %APPDATA%\\npm' },
    ])
  })

  it('finds the npm global bin from where npm lays a global install out, or the folder of a clone\'s entry point', () => {
    expect(npmGlobalBin('/usr/local/lib/node_modules/@5straps/buckle/dist/main.js', 'linux')).toBe('/usr/local/bin')
    expect(npmGlobalBin('C:/Users/me/AppData/Roaming/npm/node_modules/@5straps/buckle/dist/main.js', 'win32')).toBe('C:/Users/me/AppData/Roaming/npm')
    expect(npmGlobalBin('/home/me/code/buckle/dist/main.js', 'linux')).toBe('/home/me/code/buckle/dist')
  })

  it('leave out a place Buckle cannot read as the system does, such as a folder without a drive on Windows', () => {
    expect(ownerPlaces({ APPDATA: 'Roaming' }, 'win32', { entry: undefined, execPath: '/usr/bin/node' })).toEqual([])
  })

  it('are searched after PATH, in order, and a program found there says where', () => {
    const [path, beside, node] = [folder('on-path'), folder('beside-buckle'), folder('beside-node')]
    const places = [{ directory: beside, label: 'beside buckle' }, { directory: node, label: 'beside node' }]
    tool(node)
    const search = { untrustedRoots: [], environment: { PATH: path }, platform: 'linux' as const, places }
    expect(findProgram('buckle-placed-tool', search).found).toMatchObject({ place: 'beside node' })
    tool(beside)
    expect(findProgram('buckle-placed-tool', search)).toMatchObject({ resolved: { path: join(beside, 'buckle-placed-tool'), args: [] }, found: { place: 'beside buckle' } })
    tool(path)
    expect(findProgram('buckle-placed-tool', search)).toMatchObject({ resolved: { path: join(path, 'buckle-placed-tool') }, found: { place: 'on PATH' } })
    expect(findExecutable('buckle-placed-tool', { PATH: '' }, 'linux', places)).toBe(join(beside, 'buckle-placed-tool'))
  })

  it('are judged as PATH is: a program there inside a workspace is refused', () => {
    const workspace = folder('placed-ws')
    tool(workspace)
    const search = { untrustedRoots: rootsOf('workspace', [workspace]), environment: { PATH: '' }, platform: 'linux' as const, places: [{ directory: workspace, label: 'beside buckle' }] }
    expect(resolveProgram('buckle-placed-tool', search)).toEqual({ path: null, reason: 'buckle-placed-tool is found in or through a workspace of this node, where an agent can write, so Buckle does not run it', untrusted: true })
  })

  // On Windows a shim is read only where no place holds the program itself: an .exe beside Node beats npm's shim on PATH.
  it('on Windows hold a native program that wins over a shim found earlier', () => {
    const base = folder('windows')
    for (const directory of ['npm', 'nodejs']) mkdirSync(join(base, 'C:', directory), { recursive: true })
    writeFileSync(join(base, 'C:', 'npm', 'tool.cmd'), '@ECHO off\r\n"%~dp0tool.exe" %*\r\n')
    const places = [{ directory: 'C:/nodejs', label: 'beside node' }]
    const cwd = process.cwd()
    process.chdir(base)
    try {
      expect(findExecutable('tool', { PATH: 'C:\\npm' }, 'win32', places)).toBe('C:/npm/tool.cmd')
      writeFileSync(join(base, 'C:', 'nodejs', 'tool.exe'), '')
      chmodSync(join(base, 'C:', 'nodejs', 'tool.exe'), 0o755)
      expect(findExecutable('tool', { PATH: 'C:\\npm' }, 'win32', places)).toBe('C:/nodejs/tool.exe')
    } finally { process.chdir(cwd) }
  })
})

// A refusal reaches the manifest an agent reads, so it names each place by its label and never a path; the owner sees
// the paths in `buckle init`.
describe('the reason a program is not run', () => {
  const places = [{ directory: '/owner/npm-global/bin', label: 'beside buckle' }, { directory: '/owner/node/bin', label: 'beside node' }, { directory: 'C:/owner/npm', label: 'in %APPDATA%\\npm' }]
  const empty = mkdtempSync(join(root, 'empty-'))

  it('names PATH with its count of directories, then each place after it, as a list', () => {
    const missing = (search: { PATH: string; places: typeof places }) => resolveProgram('buckle-missing-tool', { untrustedRoots: [], environment: { PATH: search.PATH }, platform: 'linux', places: search.places })
    expect(missing({ PATH: [empty, empty, 'relative'].join(':'), places })).toEqual({
      path: null, reason: 'buckle-missing-tool was not found on PATH (2 directories), beside buckle, beside node, or in %APPDATA%\\npm', untrusted: false,
      searched: 'on PATH (2 directories), beside buckle, beside node, or in %APPDATA%\\npm',
    })
    expect(missing({ PATH: empty, places: places.slice(0, 1) })).toMatchObject({ reason: 'buckle-missing-tool was not found on PATH (1 directory) or beside buckle' })
    expect(missing({ PATH: '', places: [] })).toMatchObject({ reason: 'buckle-missing-tool was not found on PATH (0 directories)' })
  })

  it('names a path the owner configured by what it is shown as, with no search', () => {
    const configured = join(empty, 'owner-private', 'agent-browser')
    const refused = resolveProgram(configured, { untrustedRoots: [], environment: { PATH: empty }, platform: 'linux', places, shownAs: 'BUCKLE_AGENT_BROWSER_COMMAND' })
    expect(refused).toEqual({ path: null, reason: 'BUCKLE_AGENT_BROWSER_COMMAND is not installed on this node', untrusted: false })
  })
})
