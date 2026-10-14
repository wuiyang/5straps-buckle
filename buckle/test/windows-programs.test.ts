import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonObject } from '@5straps/protocol'
import { createNoneSandbox } from '../common/adapters/sandbox/none-sandbox.js'
import { findExecutable, ownerPlaces, placesOnTheWay, resolveProgram, rootsOf, runnableCommand, trustedSearchPath, type ExecutableLookup } from '../common/domain/executable.js'
import type { Pack } from '../common/domain/pack.js'
import { createPathView } from '../common/domain/path-view.js'
import { BROWSER_UNTRUSTED } from '../common/services/packs/browser/index.js'
import { createBuiltinPacks } from '../common/services/packs/index.js'
import type { ProcessRequest } from '../common/types/ports/process-runner.js'

// On Windows a program spawned by its bare name is looked for in the child's working directory before PATH, so an
// `rg.exe` the agent writes into the workspace would run with Buckle's rights. Buckle resolves each program once and
// spawns it by that path. These tests put a lookup in PATH's place and imitate Windows through the platform it takes.

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function scratch(): string {
  // A real path: a program resolves to its real path, and on macOS the temp folder is reached through a link.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-windows-programs-')))
  roots.push(root)
  return root
}

/** A lookup that answers from a table, as findExecutable would from PATH, and records the platform it was asked for. */
function lookupFrom(table: Record<string, string>): ExecutableLookup & { platforms: NodeJS.Platform[] } {
  const platforms: NodeJS.Platform[] = []
  return Object.assign((name: string, _environment: NodeJS.ProcessEnv, platform: NodeJS.Platform) => { platforms.push(platform); return table[name] ?? null }, { platforms })
}

describe('a program resolved on Windows, imitated', () => {
  const untrustedRoots = [...rootsOf('workspace', ['C:/ws']), ...rootsOf('scratch root', ['D:/scratch'])]

  it('is spawned by the absolute path PATH gives, in pathe\'s form', () => {
    const lookup = lookupFrom({ rg: 'C:\\Tools\\rg.exe' })
    expect(resolveProgram('rg', { untrustedRoots, lookup, platform: 'win32' })).toEqual({ path: 'C:/Tools/rg.exe', argv0: 'C:/Tools/rg.exe', args: [] })
    expect(lookup.platforms).toEqual(['win32'])
  })

  it('is refused where the agent writes: the workspace, a scratch root, or a case variant of either', () => {
    for (const [found, kind] of [['C:\\ws\\rg.exe', 'a workspace'], ['c:\\WS\\bin\\rg.exe', 'a workspace'], ['D:\\Scratch\\rg.exe', 'a scratch root']]) {
      expect(resolveProgram('rg', { untrustedRoots, lookup: lookupFrom({ rg: found! }), platform: 'win32' })).toEqual({ path: null, reason: `rg is found in or through ${kind} of this node, where an agent can write, so Buckle does not run it`, untrusted: true })
    }
  })

  it('is not run when PATH has none, or names it by a relative path', () => {
    expect(resolveProgram('rg', { untrustedRoots, lookup: lookupFrom({}), environment: { PATH: 'C:\\Tools;tools;D:\\bin' }, platform: 'win32' })).toEqual({ path: null, reason: 'rg was not found on PATH (2 directories)', untrusted: false, searched: 'on PATH (2 directories)' })
    expect(resolveProgram('tools\\rg.exe', { untrustedRoots, lookup: lookupFrom({ 'tools\\rg.exe': 'tools\\rg.exe' }), platform: 'win32' })).toMatchObject({ path: null, untrusted: false })
  })

  // On Linux `C:/tools` is the folder `C:` in the working directory, which stands in for the drive here. An entry with a
  // root but no drive, `\\bin` or one from `/`, is on whichever drive is current on Windows, so it is skipped too.
  it('reads PATH with Windows\' separator and searches only its entries on a drive', () => {
    const root = scratch()
    for (const directory of [join(root, 'C:', 'tools'), join(root, 'bin')]) {
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'tool.exe'), '')
      chmodSync(join(directory, 'tool.exe'), 0o755)
    }
    const cwd = process.cwd()
    process.chdir(root)
    try {
      expect(findExecutable('tool', { PATH: 'bin;C:\\tools' }, 'win32')).toBe('C:/tools/tool.exe')
      expect(findExecutable('tool', { PATH: `bin;\\bin;${root.replaceAll('/', '\\')}\\bin;${root}/bin` }, 'win32')).toBeNull()
      expect(findExecutable('tool.exe', { PATH: `${root}/bin` }, 'linux')).toBe(join(root, 'bin', 'tool.exe'))
    } finally { process.chdir(cwd) }
  })

  // npm puts only a shim on PATH, so one is read where no PATH entry holds an `.exe` or `.com` of the name; a native
  // program anywhere on PATH is still found as it was before shims were read.
  it('finds a shim only where no PATH entry holds the program itself', () => {
    const root = scratch()
    for (const directory of ['npm', 'tools']) mkdirSync(join(root, 'C:', directory), { recursive: true })
    writeFileSync(join(root, 'C:', 'npm', 'tool.cmd'), '@ECHO off\r\n"%~dp0tool.exe" %*\r\n')
    const cwd = process.cwd()
    process.chdir(root)
    try {
      expect(findExecutable('tool', { PATH: 'C:\\npm;C:\\tools' }, 'win32')).toBe('C:/npm/tool.cmd')
      writeFileSync(join(root, 'C:', 'tools', 'tool.exe'), '')
      chmodSync(join(root, 'C:', 'tools', 'tool.exe'), 0o755)
      expect(findExecutable('tool', { PATH: 'C:\\npm;C:\\tools' }, 'win32')).toBe('C:/tools/tool.exe')
      expect(findExecutable('tool.cmd', { PATH: 'C:\\npm;C:\\tools' }, 'win32')).toBe('C:/npm/tool.cmd')
      expect(findExecutable('tool', { PATH: 'C:\\npm' }, 'linux')).toBeNull()
    } finally { process.chdir(cwd) }
  })

  it('leaves a command word the agent wrote as a path as written, and resolves a bare one', () => {
    const lookup = lookupFrom({ git: 'C:\\Program Files\\Git\\cmd\\git.exe', node: 'C:\\ws\\node.exe' })
    expect(runnableCommand('git', { untrustedRoots, lookup, platform: 'win32' })).toEqual({ path: 'C:/Program Files/Git/cmd/git.exe', argv0: 'C:/Program Files/Git/cmd/git.exe', args: [] })
    expect(runnableCommand('.\\tools\\git.exe', { untrustedRoots, lookup, platform: 'win32' })).toEqual({ path: '.\\tools\\git.exe', argv0: '.\\tools\\git.exe', args: [] })
    expect(() => runnableCommand('node', { untrustedRoots, lookup, platform: 'win32' })).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }))
  })
})

// Final review of 0.1.4, finding executable 506: Windows names a folder by its 8.3 short name too, `PROJEC~1` for
// `projects-main`, which compared as text is not inside the workspace registered by its long name. Each existing name
// is read back as the disk stores it. Here the folders are real, `C:` standing in for the drive under the working
// directory, and an injected StoredPath answers as Windows would for the short ones.
describe('a program or PATH entry spelled with a Windows short name, imitated', () => {
  const workspace = rootsOf('workspace', ['C:/Users/me/projects-main'])
  /** The real path Windows gives each short name here, and any other path as named, as a disk without short names does. */
  const disk = (path: string): string => ({ 'C:/Users/me/PROJEC~1': 'C:\\Users\\me\\projects-main', 'C:/PROGRA~1': 'C:\\Program Files' } as Record<string, string>)[path] ?? path
  function short(run: () => void) {
    const root = scratch()
    for (const directory of ['Users/me/PROJEC~1/node_modules/.bin', 'PROGRA~1/Tools']) mkdirSync(join(root, 'C:', directory), { recursive: true })
    for (const file of ['Users/me/PROJEC~1/node_modules/.bin/rg.exe', 'PROGRA~1/Tools/rg.exe']) writeFileSync(join(root, 'C:', file), '')
    const cwd = process.cwd()
    process.chdir(root)
    try { run() } finally { process.chdir(cwd) }
  }

  it('refuses a program in the workspace named through its short name, and spawns one outside it by its long name', () => short(() => {
    const planted = lookupFrom({ rg: 'C:\\Users\\me\\PROJEC~1\\node_modules\\.bin\\rg.exe' })
    expect(resolveProgram('rg', { untrustedRoots: workspace, lookup: planted, platform: 'win32', storedPath: disk })).toEqual({ path: null, reason: 'rg is found in or through a workspace of this node, where an agent can write, so Buckle does not run it', untrusted: true })
    const installed = lookupFrom({ rg: 'C:\\PROGRA~1\\Tools\\rg.exe' })
    expect(resolveProgram('rg', { untrustedRoots: workspace, lookup: installed, platform: 'win32', storedPath: disk })).toEqual({ path: 'C:/Program Files/Tools/rg.exe', argv0: 'C:/PROGRA~1/Tools/rg.exe', args: [] })
  }))

  it('refuses a short name it cannot read back, or one that names nothing yet, rather than compare its text', () => short(() => {
    const unreadable = () => { throw new Error('EPERM') }
    const planted = lookupFrom({ rg: 'C:\\Users\\me\\PROJEC~1\\node_modules\\.bin\\rg.exe', fd: 'C:\\Users\\me\\LATER~1\\fd.exe' })
    expect(resolveProgram('rg', { untrustedRoots: workspace, lookup: planted, platform: 'win32', storedPath: unreadable })).toEqual({ path: null, reason: 'rg cannot be followed to where it really is, so Buckle does not run it', untrusted: true })
    expect(resolveProgram('fd', { untrustedRoots: workspace, lookup: planted, platform: 'win32', storedPath: disk })).toEqual({ path: null, reason: 'fd cannot be followed to where it really is, so Buckle does not run it', untrusted: true })
  }))

  it('drops a PATH entry in the workspace named through its short name, and hands on the others by their long names', () => short(() => {
    const searchPath = 'C:\\Users\\me\\PROJEC~1\\node_modules\\.bin;C:\\PROGRA~1\\Tools;C:\\Users\\me\\LATER~1'
    expect(trustedSearchPath(searchPath, { untrustedRoots: workspace }, 'win32', disk)).toBe('C:\\Program Files\\Tools')
  }))
})

// Recheck of the final review of 0.1.4, finding executable 567: a subst drive, or a drive mapped to a folder, names a
// folder under another letter, with no link on the way to say so. Each walked place is also judged by the real path
// Windows gives it. Here `P:` stands for the workspace's own folder, `Q:` for a tools folder outside every root, and
// `S:` for a network share, which Buckle does not use on Windows.
describe('a program or PATH entry on a subst drive, imitated', () => {
  const workspace = rootsOf('workspace', ['C:/Users/me/projects/app'])
  const backslashed = (rest: string) => rest.replaceAll('/', '\\')
  const subst = (path: string): string => {
    if (path.startsWith('P:/')) return `C:\\Users\\me\\projects\\app\\${backslashed(path.slice(3))}`
    if (path.startsWith('Q:/')) return `D:\\tools\\${backslashed(path.slice(3))}`
    if (path.startsWith('S:/')) return `\\\\server\\share\\${backslashed(path.slice(3))}`
    return path
  }
  function drives(run: () => void) {
    const root = scratch()
    for (const directory of ['P:/node_modules/.bin', 'Q:', 'S:']) mkdirSync(join(root, directory), { recursive: true })
    for (const file of ['P:/node_modules/.bin/rg.exe', 'Q:/rg.exe', 'S:/rg.exe']) writeFileSync(join(root, file), '')
    const cwd = process.cwd()
    process.chdir(root)
    try { run() } finally { process.chdir(cwd) }
  }
  const found = (path: string) => lookupFrom({ rg: path })

  it('refuses a program the drive leads into the workspace, on a share, or whose real path cannot be read, and runs one outside every root', () => drives(() => {
    expect(resolveProgram('rg', { untrustedRoots: workspace, lookup: found('P:\\node_modules\\.bin\\rg.exe'), platform: 'win32', storedPath: subst })).toEqual({ path: null, reason: 'rg is found in or through a workspace of this node, where an agent can write, so Buckle does not run it', untrusted: true })
    expect(resolveProgram('rg', { untrustedRoots: workspace, lookup: found('S:\\rg.exe'), platform: 'win32', storedPath: subst })).toEqual({ path: null, reason: 'rg cannot be followed to where it really is, so Buckle does not run it', untrusted: true })
    expect(resolveProgram('rg', { untrustedRoots: workspace, lookup: found('Q:\\rg.exe'), platform: 'win32', storedPath: () => { throw new Error('EPERM') } })).toEqual({ path: null, reason: 'rg cannot be followed to where it really is, so Buckle does not run it', untrusted: true })
    expect(resolveProgram('rg', { untrustedRoots: workspace, lookup: found('Q:\\rg.exe'), platform: 'win32', storedPath: subst })).toEqual({ path: 'Q:/rg.exe', argv0: 'Q:/rg.exe', args: [] })
  }))

  it('drops each PATH entry the drive leads into the workspace or onto a share, its root too, and keeps one outside every root', () => drives(() => {
    expect(trustedSearchPath('P:\\node_modules\\.bin;P:\\;S:\\;Q:\\', { untrustedRoots: workspace }, 'win32', subst)).toBe('Q:\\')
    // A browser profile folder is judged by the same places.
    expect(placesOnTheWay('P:/profile', 'win32', subst)).toContain('C:/Users/me/projects/app/profile')
  }))
})

/** The built-in packs over a real workspace, with programs looked up in `table` as Windows would, and every spawn recorded. */
function builtins(input: { table: (root: string) => Record<string, string> }) {
  const root = scratch()
  const state = scratch()
  const spawned: ProcessRequest[] = []
  const packs = createBuiltinPacks({
    allowHostGit: true,
    allowHostLsp: true,
    cwd: root,
    paths: createPathView({ root, mount: null }),
    hiddenPaths: [state],
    mountReadOnlyPaths: [],
    approvedUrls: null,
    approvedLists: [],
    // git is answered as if the workspace were its repository, which the git pack asks before it runs.
    runProcess: async request => { spawned.push(request); return { exitCode: 0, signal: null, stdout: request.args[0] === 'rev-parse' ? `${root}\n${root}\n${root}\n` : '', stderr: '', truncated: false, timedOut: false } },
    sandbox: createNoneSandbox(),
    writableRoots: [root],
    allowedHosts: [],
    forge: { apiUrl: 'https://api.github.com', author: { name: 'test', email: 'test@example.com' } },
    stateDirectory: state,
    agentBrowserCommand: 'agent-browser',
    browserStateDirectory: join(state, 'browser'),
    browserHeaded: false,
    enableShell: true,
    sandboxUnavailableReason: null,
    programSearch: { lookup: lookupFrom(input.table(root)), platform: 'win32' },
  })
  const pack = (id: string): Pack => packs.find(candidate => candidate.id === id)!
  const call = (id: string, name: string, args: JsonObject) => {
    const tool = pack(id).tools.find(candidate => candidate.capability.name === name)
    if (!tool) throw new Error(`No such tool: ${name}`)
    return tool.prepare(args).execute({ requestId: 'r1', sessionId: 's1', timeoutMs: 5_000, signal: AbortSignal.timeout(5_000), authorizeRead: async () => true })
  }
  return { root, pack, call, spawned }
}

const TRUSTED = { 'rg': '/opt/tools/rg.exe', 'git': '/opt/tools/git.exe', 'ps': '/opt/tools/ps.exe', 'agent-browser': '/opt/tools/agent-browser.exe' }

describe('the packs on Windows, imitated, with every program on PATH outside the workspace', () => {
  it('spawn rg, git, ps, and the unsandboxed shell\'s command word by the path PATH gave', async () => {
    const { call, spawned, pack } = builtins({ table: () => TRUSTED })
    await call('fs', 'fs_search_content', { pattern: 'x' })
    await call('git', 'git_status', {})
    await call('dev', 'lsp_discover', {})
    await call('shell', 'shell_exec', { command: 'git', args: ['status'] })
    expect([...new Set(spawned.map(request => request.command))].sort()).toEqual(['/opt/tools/git.exe', '/opt/tools/ps.exe', '/opt/tools/rg.exe'])
    expect(pack('browser').unavailableReason).toBeNull()
    expect(pack('git').unavailableReason).toBeNull()
  })
})

describe('the packs on Windows, imitated, with programs planted in the workspace', () => {
  it('withhold search, git, and the browser, and refuse the language server, ps, and the shell\'s command word', async () => {
    const planted = (root: string) => Object.fromEntries(['rg', 'git', 'ps', 'agent-browser', 'typescript-language-server', 'node'].map(name => [name, `${root}\\bin\\${name}.exe`]))
    const { root, call, spawned, pack } = builtins({ table: planted })
    mkdirSync(join(root, 'bin'))
    expect(pack('fs').tools.map(tool => tool.capability.name)).not.toContain('fs_search_content')
    expect(pack('git').unavailableReason).toBe('git is found in or through a workspace of this node, where an agent can write, so Buckle does not run it')
    expect(pack('forge').unavailableReason).toMatch(/BUCKLE_FORGE_GITHUB_TOKEN/)
    expect(pack('browser').unavailableReason).toBe(BROWSER_UNTRUSTED)
    writeFileSync(join(root, 'a.ts'), 'export const a = 1\n')
    await expect(call('dev', 'lsp_hover', { path: 'a.ts', language: 'typescript', line: 1 })).rejects.toThrow('typescript-language-server is found in or through a workspace')
    await expect(call('dev', 'lsp_discover', {})).rejects.toThrow('ps is found in or through a workspace')
    await expect(call('shell', 'shell_exec', { command: 'node', args: ['-e', '1'] })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(spawned).toEqual([])
  })
})

/** An npm prefix outside the workspace whose `<name>.cmd` is npm's shim for a node script, which exists. */
function npmPrefix(name: string): { shim: string; script: string } {
  const prefix = scratch()
  const script = join(prefix, 'node_modules', name, 'bin', `${name}.js`)
  mkdirSync(join(script, '..'), { recursive: true })
  writeFileSync(script, '')
  const shim = join(prefix, `${name}.cmd`)
  writeFileSync(shim, `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\${name}\\bin\\${name}.js" %*\r\n`)
  return { shim, script }
}

describe('the packs on Windows, imitated, with programs npm installed as shims', () => {
  it('run the browser through Buckle\'s own Node, the script first and the command after it', async () => {
    const browser = npmPrefix('agent-browser')
    const { call, spawned, pack } = builtins({ table: () => ({ ...TRUSTED, 'agent-browser': browser.shim }) })
    expect(pack('browser').unavailableReason).toBeNull()
    await call('browser', 'browser_command', { command: 'open', args: ['https://example.com'] })
    expect(spawned.at(-1)).toMatchObject({ command: process.execPath, argv0: process.execPath })
    expect(spawned.at(-1)!.args.slice(0, 3)).toEqual([browser.script, 'open', 'https://example.com/'])
  })

  it('run the unsandboxed shell\'s command word the same way', async () => {
    const tsc = npmPrefix('tsc')
    const { call, spawned } = builtins({ table: () => ({ tsc: tsc.shim }) })
    await call('shell', 'shell_exec', { command: 'tsc', args: ['--version'] })
    expect(spawned.at(-1)).toMatchObject({ command: process.execPath, args: [tsc.script, '--version'] })
  })
})

// The withheld reason says where Buckle looked, each place by its label, and the shim it could not read by its file
// name: the manifest carrying it is read by the agent, and the folders are the owner's.
describe('the browser pack on Windows, imitated, without an agent-browser it can run', () => {
  /** The browser pack's reason with PATH and %APPDATA%\\npm searched for real, under a scratch folder standing in for C:. */
  function withheld(shim: string | null): string | null {
    const root = scratch()
    for (const directory of ['Windows', 'Users/me/AppData/Roaming/npm']) mkdirSync(join(root, 'C:', directory), { recursive: true })
    if (shim !== null) writeFileSync(join(root, 'C:', 'Users/me/AppData/Roaming/npm/agent-browser.cmd'), shim)
    const cwd = process.cwd()
    process.chdir(root)
    try {
      const environment = { PATH: 'C:\\Windows;C:\\Windows\\System32', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }
      const packs = createBuiltinPacks({
        cwd: root, paths: createPathView({ root, mount: null }), hiddenPaths: [], mountReadOnlyPaths: [], approvedUrls: null, approvedLists: [],
        runProcess: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false }),
        sandbox: createNoneSandbox(), writableRoots: [root], allowedHosts: [], stateDirectory: scratch(), agentBrowserCommand: 'agent-browser',
        forge: { apiUrl: 'https://api.github.com', author: { name: 'test', email: 'test@example.com' } }, browserStateDirectory: join(scratch(), 'browser'),
        browserHeaded: false, enableShell: false, sandboxUnavailableReason: null,
        // The scratch folders stand in for drives: each path resolves as named, as on a drive with no subst.
        programSearch: { environment, platform: 'win32', places: ownerPlaces(environment, 'win32', { entry: undefined, execPath: 'D:\\node\\node.exe' }), storedPath: path => path },
      })
      const reason = packs.find(pack => pack.id === 'browser')!.unavailableReason
      expect(reason).not.toContain(root)
      expect(reason).not.toMatch(/Users|me\\|Roaming|D:/)
      return reason
    } finally { process.chdir(cwd) }
  }

  it('names PATH with its count, beside node, and %APPDATA%\\npm, and how to install it', () => {
    expect(withheld(null)).toBe('agent-browser was not found on PATH (2 directories), beside node, or in %APPDATA%\\npm; install it with npm i -g agent-browser, then run agent-browser install')
  })

  it('names a shim it found and could not read by its file and its place, and the setting that fixes it', () => {
    expect(withheld('@ECHO off\r\n"%~dp0\\..\\agent-browser.sh" %*\r\n')).toBe('agent-browser was found in %APPDATA%\\npm as agent-browser.cmd, a shim Buckle cannot read; set BUCKLE_AGENT_BROWSER_COMMAND to the agent-browser .exe or script inside its package')
  })
})
