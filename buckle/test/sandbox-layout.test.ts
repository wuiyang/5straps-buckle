import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createBubblewrapSandbox, ETC_FILES, SANDBOX_HOSTNAME, SANDBOX_USER } from '../common/adapters/sandbox/bubblewrap-sandbox.js'
import { createPathView } from '../common/domain/path-view.js'
import { loadConfig } from '../common/runtime/config.js'
import { createShellPack } from '../common/services/packs/shell/index.js'
import type { ProcessRequest } from '../common/types/ports/process-runner.js'
import type { SandboxCommand } from '../common/types/ports/sandbox.js'
import { runsNativeTerminal } from './support/native-terminal.js'
import { byName, idOf, registerWorkspace, workspacesOf } from './support/workspaces.js'
import type { WorkspaceSettings } from '../common/services/workspaces/workspace-settings.js'

// Phase 2 item 3 of the workspace-model brief (D85, Q1 and Q11): bubblewrap from the mount table, an empty root, the
// system folders and the chosen /etc files, each mount at its target, the user `agent` on the host `buckle`, and the
// variables a command reads set by Buckle. No bwrap runs here: the layout is read from its arguments, as every
// sandbox test reads it, and CI installs none either (a known limit).

const roots: string[] = []
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-layout-')))
  roots.push(root)
  return root
}

const STATE = '/home/me/.5straps/buckle'

function command(overrides: Partial<SandboxCommand> = {}): SandboxCommand {
  return {
    command: 'ls', args: ['/'], cwd: '/work/project', writableRoots: ['/work/project'], allowNetwork: false,
    mount: { root: '/work/project', at: '/workspace' }, hiddenPaths: [STATE], readOnlyPaths: ['/home/me/.cargo'],
    mounts: [{ source: '/home/me/data', target: '/data', readOnly: false }, { source: '/home/me/docs', target: '/srv/docs', readOnly: true }],
    ...overrides,
  }
}

function pairs(args: string[], flag: string): string[][] {
  return args.flatMap((argument, index) => argument === flag ? [args.slice(index + 1, index + 3)] : [])
}

describe('the bubblewrap layout', () => {
  const sandbox = createBubblewrapSandbox('/usr/bin/bwrap', { nodePrefix: '/home/me/.nvm/versions/node/v24' })
  const { args } = sandbox.wrap(command())

  it('starts from an empty root on a host named buckle', () => {
    expect(args.slice(args.indexOf('--tmpfs'), args.indexOf('--tmpfs') + 4)).toEqual(['--tmpfs', '/', '--hostname', SANDBOX_HOSTNAME])
    expect(args.indexOf('--hostname')).toBeLessThan(args.indexOf('--ro-bind-try'))
    expect(args).toContain('--unshare-uts')
  })

  it('binds the system folders, the chosen /etc files, the Node install, and the toolchains at their own paths, never the host\'s accounts', () => {
    const fixed = pairs(args, '--ro-bind-try')
    for (const path of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/home/me/.nvm/versions/node/v24', '/home/me/.cargo']) expect(fixed).toContainEqual([path, path])
    // Every /etc file the layout names is bound at its own path, whichever it is.
    for (const path of ETC_FILES) expect(fixed).toContainEqual([path, path])
    expect(args).not.toContain('/etc/passwd')
    expect(args).not.toContain('/etc/group')
    // The machine's hosts file names it, and not the sandbox's host: the sandbox writes its own.
    expect(args).not.toContain('/etc/hosts')
    expect(fixed.map(([path]) => path)).not.toContain('/etc')
  })

  // The list is pinned whole, so a file dropped from it, the time zone included, is a change a reviewer sees here: the
  // loader cache; name lookup (nsswitch, resolv.conf); the links Debian and Ubuntu reach awk, which, and cc through;
  // the certificate stores of Debian and Fedora, and Fedora's OpenSSL default CA file; services and protocols; the time zone.
  it('names the /etc files the page promises: the loader cache, name lookup, certificates, and the time zone', () => {
    expect([...ETC_FILES]).toEqual([
      '/etc/ld.so.cache', '/etc/nsswitch.conf', '/etc/resolv.conf', '/etc/services', '/etc/protocols', '/etc/ssl/certs', '/etc/pki/tls/certs',
      '/etc/pki/tls/cert.pem', '/etc/pki/ca-trust/extracted', '/etc/localtime', '/etc/alternatives',
    ])
  })

  it('binds the folder at its target, then each mount at its own, writable as the owner shares it', () => {
    expect(pairs(args, '--ro-bind')).toContainEqual(['/work/project', '/workspace'])
    expect(pairs(args, '--bind')).toContainEqual(['/home/me/data', '/data'])
    expect(pairs(args, '--ro-bind')).toContainEqual(['/home/me/docs', '/srv/docs'])
    expect(pairs(args, '--chdir')[0]![0]).toBe('/workspace')
  })

  it('lays a mask over hidden state only where something bound would show it, at the path it shows at', () => {
    // Nothing bound holds the state directory, so no folder of the owner's is made to hold a mask.
    expect(pairs(args, '--tmpfs').map(([path]) => path)).toEqual(['/', '/tmp'])
    expect(args.some(argument => argument.startsWith('/home/me/.5straps'))).toBe(false)
    const inToolchain = sandbox.wrap(command({ hiddenPaths: ['/home/me/.cargo/credentials'], hiddenFiles: ['/work/project/.env', '/elsewhere/.env'] })).args
    expect(pairs(inToolchain, '--tmpfs')).toContainEqual(['/home/me/.cargo/credentials', '--ro-bind'])
    expect(pairs(inToolchain, '--ro-bind')).toContainEqual(['/dev/null', '/workspace/.env'])
    expect(inToolchain).not.toContain('/elsewhere/.env')
  })

  it('binds an approved sensitive file over its own mask', () => {
    const { args: approved } = sandbox.wrap(command({ hiddenFiles: ['/work/project/.env'], overlays: [{ source: '/work/project/.env', target: '/workspace/.env', readOnly: true }] }))
    expect(approved.lastIndexOf('/workspace/.env')).toBeGreaterThan(approved.indexOf('/dev/null'))
    expect(pairs(approved, '--ro-bind').at(-1)).toEqual(['/work/project/.env', '/workspace/.env'])
  })

  it('masks hidden state inside a mount where the mount shows it, after binding the mount', () => {
    const { args: masked } = sandbox.wrap(command({
      mounts: [{ source: '/home/me/data', target: '/data', readOnly: false }, { source: '/home/me/scratch', target: '/home/me/scratch', readOnly: true }],
      hiddenPaths: [STATE, '/home/me/scratch/node-state'], hiddenFiles: ['/home/me/scratch/.env', '/home/me/scratch/.ssh/id_ed25519', '/home/me/data/.env'],
    }))
    const at = (flag: string, pair: string[]) => masked.findIndex((argument, index) => argument === flag && masked[index + 1] === pair[0] && masked[index + 2] === pair[1])
    const scratchBind = at('--ro-bind', ['/home/me/scratch', '/home/me/scratch'])
    expect(scratchBind).toBeGreaterThan(-1)
    expect(at('--tmpfs', ['/home/me/scratch/node-state', '--ro-bind'])).toBeGreaterThan(scratchBind)
    for (const file of ['/home/me/scratch/.env', '/home/me/scratch/.ssh/id_ed25519']) expect(at('--ro-bind', ['/dev/null', file])).toBeGreaterThan(scratchBind)
    expect(at('--ro-bind', ['/dev/null', '/data/.env'])).toBeGreaterThan(at('--bind', ['/home/me/data', '/data']))
    expect(masked).not.toContain('/home/me/data/.env')
  })

  it('gives every command its PATH, user, shell, and TMPDIR, none of them the node\'s', () => {
    vi.stubEnv('PATH', '/home/me/.local/bin:/usr/bin')
    vi.stubEnv('USER', 'me')
    expect(sandbox.environment!(['/home/me/.cargo'])).toEqual({
      PATH: '/home/me/.nvm/versions/node/v24/bin:/home/me/.cargo/bin:/home/me/.cargo:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      USER: SANDBOX_USER, LOGNAME: SANDBOX_USER, SHELL: '/bin/sh', TMPDIR: '/tmp',
    })
  })
})

describe('the sandbox\'s own accounts', () => {
  it('name the command\'s user and group agent, at the sandbox home, bound over /etc/passwd and /etc/group', () => {
    const directory = join(scratch(), 'sandbox-etc')
    const sandbox = createBubblewrapSandbox('/usr/bin/bwrap', { nodePrefix: '/opt/node', identityDirectory: directory })
    const { args } = sandbox.wrap(command())
    expect(pairs(args, '--ro-bind')).toContainEqual([join(directory, 'passwd'), '/etc/passwd'])
    expect(pairs(args, '--ro-bind')).toContainEqual([join(directory, 'group'), '/etc/group'])
    expect(readFileSync(join(directory, 'passwd'), 'utf8')).toBe(`agent:x:${process.getuid!()}:${process.getgid!()}:agent:/tmp/home:/bin/sh\n`)
    expect(readFileSync(join(directory, 'group'), 'utf8')).toBe(`agent:x:${process.getgid!()}:\n`)
    expect(readFileSync(join(directory, 'passwd'), 'utf8')).not.toContain(process.env.USER ?? 'nobody-here')
  })

  it('name the sandbox\'s host buckle and the loopback in a hosts file of its own, in place of the machine\'s', () => {
    const directory = join(scratch(), 'sandbox-etc')
    const { args } = createBubblewrapSandbox('/usr/bin/bwrap', { nodePrefix: '/opt/node', identityDirectory: directory }).wrap(command())
    expect(pairs(args, '--ro-bind')).toContainEqual([join(directory, 'hosts'), '/etc/hosts'])
    expect(pairs(args, '--ro-bind-try').map(([path]) => path)).not.toContain('/etc/hosts')
    const hosts = readFileSync(join(directory, 'hosts'), 'utf8')
    expect(hosts).toBe(`127.0.0.1 localhost\n127.0.1.1 ${SANDBOX_HOSTNAME}\n::1 localhost ip6-localhost ip6-loopback\n`)
    expect(hosts).not.toContain(hostname())
  })
})

describe('a shell command\'s variables', () => {
  it('are Buckle\'s for the sandbox, then the workspace\'s, then the call\'s own', async () => {
    const root = scratch()
    vi.stubEnv('PATH', '/home/me/.local/bin:/usr/bin')
    vi.stubEnv('USER', 'me')
    vi.stubEnv('TMPDIR', '/run/user/1000/tmp')
    const calls: ProcessRequest[] = []
    const pack = createShellPack({
      paths: createPathView({ root, mount: '/workspace' }), sandbox: createBubblewrapSandbox('/usr/bin/bwrap', { nodePrefix: '/opt/node' }),
      writableRoots: [root], hiddenPaths: [], readOnlyPaths: [], unavailableReason: null, commandEnvironment: { LANG_HINT: 'workspace' },
      runProcess: async (request) => { calls.push(request); return { exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false } },
    })
    const run = (env: Record<string, string>) => pack.tools[0]!.prepare({ command: 'true', env }).execute({ requestId: randomUUID(), sessionId: 'caller', timeoutMs: 1000, signal: new AbortController().signal })
    await run({})
    expect(calls[0]!.environment).toMatchObject({ PATH: '/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', USER: 'agent', LOGNAME: 'agent', SHELL: '/bin/sh', TMPDIR: '/tmp', LANG_HINT: 'workspace' })
    await run({ PATH: '/workspace/bin:/usr/bin' })
    expect(calls[1]!.environment).toMatchObject({ PATH: '/workspace/bin:/usr/bin', USER: 'agent' })
  })
})

// Finding 28 of the fourth recheck, as the shell pack has it: the credential scan took every writable root, so a scratch
// root not made yet failed every sandboxed shell call with a raw ENOENT naming the owner's path, where the binds skip it.
describe('a sandboxed shell command and a scratch root that does not exist', () => {
  it('runs, binding and scanning only what exists', async () => {
    const root = scratch()
    const missing = join(scratch(), 'never-made')
    const calls: ProcessRequest[] = []
    const pack = createShellPack({
      paths: createPathView({ root, mount: '/workspace', scratchRoots: [missing] }), sandbox: createBubblewrapSandbox('/usr/bin/bwrap', { nodePrefix: '/opt/node' }),
      writableRoots: [root, missing], hiddenPaths: [], readOnlyPaths: [], unavailableReason: null,
      runProcess: async (request) => { calls.push(request); return { exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false } },
    })
    await pack.tools[0]!.prepare({ command: 'true', env: {} }).execute({ requestId: randomUUID(), sessionId: 'caller', timeoutMs: 1000, signal: new AbortController().signal })
    expect(calls).toHaveLength(1)
    for (const flag of ['--bind', '--ro-bind', '--ro-bind-try']) expect(pairs(calls[0]!.args, flag).filter(([source, target]) => source === missing || target === missing)).toEqual([])
  })
})

describe.runIf(runsNativeTerminal)('a workbench terminal\'s variables', () => {
  it('are the shell\'s, the workspace\'s over Buckle\'s, with its TERM', async () => {
    const root = scratch()
    const folder = join(root, 'site')
    mkdirSync(folder)
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const seen = join(root, 'seen.env')
    writeFileSync(join(bin, 'bwrap'), `#!/bin/sh\nenv > '${seen}'\n`)
    chmodSync(join(bin, 'bwrap'), 0o755)
    vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`)
    vi.stubEnv('USER', 'me')
    const manager = await workspacesOf(loadConfig({ BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'bubblewrap', BUCKLE_SHELL_ISOLATION: 'false' }))
    await registerWorkspace(manager, { id: 'site', dir: folder })
    await manager.updateSettings(idOf(manager, 'site'), settings => ({ ...settings, env: { WORKSPACE_FIXTURE: 'from-the-workspace', TERM: 'dumb' } }))
    const { runtime } = await byName(manager, 'site')
    const grant = { id: randomUUID(), token: 'workbench-fixture-token-with-enough-bytes', projectId: 'project-a', chatId: 'chat-a', allowShell: true }
    await runtime.workbenches.provision(grant)
    await runtime.workbenches.startTerminal(grant.id, { actorId: 'alice', cwd: '.', cols: 80, rows: 24 })
    await vi.waitFor(() => expect(existsSync(seen) && readFileSync(seen, 'utf8')).toMatch(/TERM=xterm-256color/))
    const variables = readFileSync(seen, 'utf8')
    expect(variables).toMatch(/^WORKSPACE_FIXTURE=from-the-workspace$/m)
    expect(variables).toMatch(/^USER=agent$/m)
    expect(variables).toMatch(/^TMPDIR=\/tmp$/m)
    expect(variables).not.toContain(`${bin}:`)
    await manager.close()
  })
})

// A terminal works in the workbench's own copy, so what it shares of the owner's is read-only there, and its network is
// the shell's: off unless shell.network is on and the workspace has no URL list to hold it to (the list is the
// workspace's, else the node's, BUCKLE_ALLOWED_HOSTS folded in). The runtime builds the layout; a fake bwrap records it.
describe.runIf(runsNativeTerminal)('a workbench terminal\'s layout', () => {
  async function terminalArguments(input: { environment?: Record<string, string>; settings?: (settings: WorkspaceSettings) => WorkspaceSettings; mount?: boolean; scratchRoot?: (root: string) => string; goneBeforeStart?: boolean }): Promise<string[]> {
    const root = scratch()
    const folder = join(root, 'site')
    const data = join(root, 'data')
    const bin = join(root, 'bin')
    for (const path of [folder, data, bin]) mkdirSync(path)
    const scratchRoot = input.scratchRoot?.(root)
    const seen = join(root, 'seen.args')
    writeFileSync(join(bin, 'bwrap'), `#!/bin/sh\nset -e\nprintf '%s\\n' "$@" > '${seen}.tmp'\nmv '${seen}.tmp' '${seen}'\n`)
    chmodSync(join(bin, 'bwrap'), 0o755)
    vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`)
    const manager = await workspacesOf(loadConfig({ BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'bubblewrap', BUCKLE_SHELL_ISOLATION: 'false', ...(scratchRoot ? { BUCKLE_SCRATCH_ROOTS: scratchRoot } : {}), ...input.environment }))
    await registerWorkspace(manager, { id: 'site', dir: folder })
    const id = idOf(manager, 'site')
    if (input.mount) await manager.addMount(id, { source: data, target: '/data', access: 'rw' })
    if (input.settings) await manager.updateSettings(id, input.settings)
    const { runtime } = await byName(manager, 'site')
    if (input.goneBeforeStart && scratchRoot) rmSync(scratchRoot, { recursive: true, force: true })
    const grant = { id: randomUUID(), token: 'workbench-fixture-token-with-enough-bytes', projectId: 'project-a', chatId: 'chat-a', allowShell: true }
    await runtime.workbenches.provision(grant)
    await runtime.workbenches.startTerminal(grant.id, { actorId: 'alice', cwd: '.', cols: 80, rows: 24 })
    await vi.waitFor(() => expect(existsSync(seen)).toBe(true))
    const args = readFileSync(seen, 'utf8').split('\n')
    await manager.close()
    return args
  }

  it('binds the owner\'s writable mounts read-only, as it works on a copy', async () => {
    const args = await terminalArguments({ mount: true })
    const data = args.find((argument, index) => argument.endsWith('/data') && args[index + 1] === '/data')!
    expect(pairs(args, '--ro-bind')).toContainEqual([data, '/data'])
    expect(pairs(args, '--bind').map(([, target]) => target)).not.toContain('/data')
  })

  it('binds a scratch root outside the folder read-only, and masks the credentials inside it where it shows them', async () => {
    const args = await terminalArguments({
      scratchRoot: (root) => {
        const scratchRoot = join(root, 'scratch')
        mkdirSync(join(scratchRoot, '.ssh'), { recursive: true })
        writeFileSync(join(scratchRoot, '.env'), 'TOKEN=scratch-fixture\n')
        writeFileSync(join(scratchRoot, '.ssh', 'id_ed25519'), 'key')
        return scratchRoot
      },
    })
    const scratchRoot = args.find(argument => argument.endsWith('/scratch'))!
    const bind = args.findIndex((argument, index) => argument === '--ro-bind' && args[index + 1] === scratchRoot && args[index + 2] === scratchRoot)
    expect(bind).toBeGreaterThan(-1)
    expect(pairs(args, '--bind').map(([, target]) => target)).not.toContain(scratchRoot)
    for (const file of [join(scratchRoot, '.env'), join(scratchRoot, '.ssh', 'id_ed25519')]) {
      expect(args.findIndex((argument, index) => argument === '--ro-bind' && args[index + 1] === '/dev/null' && args[index + 2] === file)).toBeGreaterThan(bind)
    }
  })

  // Finding 27 of the fourth recheck: the filter that leaves a scratch root inside the folder to the workbench's copy
  // had no test, and without it the terminal of the workspace whose folder holds the root was refused as an overlap.
  it('opens where a scratch root sits inside the folder, which the workbench\'s copy holds, and binds it nowhere on its own', async () => {
    let inside = ''
    const args = await terminalArguments({ scratchRoot: (root) => { inside = join(root, 'site', 'tmp'); mkdirSync(inside); return inside } })
    expect(args).toContain('--chdir')
    for (const flag of ['--bind', '--ro-bind', '--ro-bind-try']) expect(pairs(args, flag).filter(([source, target]) => source === inside || target === inside)).toEqual([])
  })

  // Finding 28: the credential scan took every outside scratch root, so one not made yet, or removed since the node
  // started, failed every terminal start with a raw ENOENT naming the owner's path, while the binds skipped it.
  it.each([
    ['not made yet', false],
    ['removed since the runtime opened', true],
  ])('opens where a scratch root outside the folder is %s, binding and scanning only the roots that exist', async (_when, goneBeforeStart) => {
    let missing = ''
    const args = await terminalArguments({ goneBeforeStart, scratchRoot: (root) => { missing = join(root, 'scratch-later'); if (goneBeforeStart) mkdirSync(missing); return missing } })
    expect(args).toContain('--chdir')
    for (const flag of ['--bind', '--ro-bind', '--ro-bind-try']) expect(pairs(args, flag).filter(([source, target]) => source === missing || target === missing)).toEqual([])
  })

  it.each([
    ['is off the network by default', {}, undefined, true],
    ['reaches the network with shell.network on and no URL list', {}, (settings: WorkspaceSettings) => ({ ...settings, shell: { ...settings.shell, network: true } }), false],
    ['stays off the network with shell.network on and a URL list of the workspace\'s own', {}, (settings: WorkspaceSettings) => ({ ...settings, shell: { ...settings.shell, network: true }, policy: { ...settings.policy, network: { allow: ['example.com'] } } }), true],
    ['stays off the network with shell.network on and the URL list the node gives it in BUCKLE_ALLOWED_HOSTS', { BUCKLE_ALLOWED_HOSTS: 'example.com' }, (settings: WorkspaceSettings) => ({ ...settings, shell: { ...settings.shell, network: true } }), true],
  ])('%s', async (_when, environment, settings, off) => {
    const args = await terminalArguments({ environment, ...(settings ? { settings } : {}) })
    expect(args.includes('--unshare-net')).toBe(off)
  })
})
