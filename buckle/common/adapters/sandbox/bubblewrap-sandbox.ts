import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'pathe'
import { SYSTEM_PROGRAM_FOLDERS } from '../../domain/mount-table.js'
import { SANDBOX_HOME } from '../../domain/sandbox-mounts.js'
import { isInside } from '../../domain/paths.js'
import type { Sandbox, SandboxCommand } from '../../types/ports/sandbox.js'
import { setMode } from '../file-modes.js'

/** Who and where a sandboxed command is (Q11 of the workspace-model brief): the user `agent` on the host `buckle`. */
export const SANDBOX_USER = 'agent'
export const SANDBOX_HOSTNAME = 'buckle'

/**
 * `identityDirectory`: where the sandbox's own /etc/passwd, /etc/group, and /etc/hosts are written, naming the command's
 * user `agent` and its host `buckle`, so the owner's account, its home, and the machine's names never show; without one,
 * none of them is bound, and the host's own are never. `nodePrefix`: the Node Buckle runs on, bound at its own path; the
 * host's unless a test names one.
 */
export function createBubblewrapSandbox(bwrapPath: string, options: { nodePrefix?: string; identityDirectory?: string } = {}): Sandbox {
  const nodePrefix = options.nodePrefix ?? dirname(dirname(process.execPath))
  const identity = options.identityDirectory === undefined ? null : writeSandboxEtc(options.identityDirectory)
  return {
    mode: 'bubblewrap',
    supportsMount: true,
    wrap: command => ({ command: bwrapPath, args: buildArgs(command, nodePrefix, identity) }),
    environment: readOnlyPaths => sandboxEnvironment(nodePrefix, readOnlyPaths),
  }
}

/**
 * The host files /etc is built from: the loader's cache, name lookup and the services and protocols it reads,
 * certificates (Fedora's OpenSSL reads /etc/pki/tls/cert.pem by default), the time zone, and the program alternatives
 * Debian and Ubuntu reach `awk`, `which`, and `cc` through; never the host's accounts or its hosts file, which the
 * sandbox writes its own of.
 */
export const ETC_FILES: readonly string[] = Object.freeze(['/etc/ld.so.cache', '/etc/nsswitch.conf', '/etc/resolv.conf', '/etc/services', '/etc/protocols', '/etc/ssl/certs', '/etc/pki/tls/certs', '/etc/pki/tls/cert.pem', '/etc/pki/ca-trust/extracted', '/etc/localtime', '/etc/alternatives'])

/**
 * The bubblewrap layout (Phase 2 item 3, Q11): an empty root (`--tmpfs /`), the system folders and the chosen /etc
 * files, the Node install and the node's toolchains at their own paths, `--dev`, `--proc`, `--tmpfs /tmp` with the
 * sandbox home, the workspace's folder and each mount at its target, and the host named `buckle`. A mask over hidden
 * state is laid only where that state would show (inside something bound), at the path it shows at, so no folder of
 * the owner's (`/home/<owner>/.5straps`) is made to hold one. `/proc/self/mountinfo` still names each bind's source,
 * which no layout hides (a known limit).
 */
function buildArgs(command: SandboxCommand, nodePrefix: string, identity: SandboxEtc | null): string[] {
  const args = ['--die-with-parent', '--unshare-user', '--unshare-pid', '--unshare-uts', '--unshare-ipc']
  if (command.commandIsPid1) args.push('--as-pid-1')
  if (!command.allowNetwork) args.push('--unshare-net')
  args.push('--tmpfs', '/', '--hostname', SANDBOX_HOSTNAME)
  const fixed = [...new Set([...SYSTEM_PROGRAM_FOLDERS, nodePrefix, ...command.readOnlyPaths])]
  for (const path of [...new Set([...SYSTEM_PROGRAM_FOLDERS, ...ETC_FILES, nodePrefix, ...command.readOnlyPaths])]) args.push('--ro-bind-try', path, path)
  if (identity) args.push('--ro-bind', identity.passwd, '/etc/passwd', '--ro-bind', identity.group, '/etc/group', '--ro-bind', identity.hosts, '/etc/hosts')
  args.push('--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--dir', SANDBOX_HOME, '--setenv', 'HOME', SANDBOX_HOME)
  const root = command.workspaceRoot ?? command.mount?.root ?? command.writableRoots[0] ?? command.cwd
  args.push('--ro-bind', root, sandboxPath(root, command))
  for (const path of command.writableRoots) args.push('--bind', path, sandboxPath(path, command))
  for (const path of command.readOnlyWorkspacePaths ?? []) args.push('--ro-bind', path, sandboxPath(path, command))
  // Every mount before the masks, so hidden state inside one is masked where it shows, over the mount.
  for (const mount of command.mounts ?? []) args.push(mount.readOnly ? '--ro-bind' : '--bind', mount.source, mount.target)
  const shown = (path: string): string[] => shownAt(path, { command, root, fixed })
  for (const path of command.hiddenPaths) for (const at of shown(path)) args.push('--tmpfs', at)
  for (const path of command.hiddenFiles ?? []) for (const at of shown(path)) args.push('--ro-bind', '/dev/null', at)
  // After the masks: an approved sensitive file is bound over its own mask.
  for (const overlay of command.overlays ?? []) args.push('--ro-bind', overlay.source, overlay.target)
  args.push('--chdir', sandboxPath(command.cwd, command), '--', command.command, ...command.args)
  return args
}

/**
 * Every place a hidden host path shows inside the sandbox, none where nothing bound holds it, so a mask is laid at each
 * (fix brief 6, item 3): inside the workspace's folder or a writable root, below where that is bound (the folder's
 * mount, or a root's own path); inside a mount's source, at the mount's target with the rest; inside a folder bound at
 * its own path, there. One host path bound twice shows twice.
 */
function shownAt(path: string, input: { command: SandboxCommand; root: string; fixed: readonly string[] }): string[] {
  const { command } = input
  const places: string[] = []
  const below = (at: string, rest: string) => (rest === '' ? at : `${at === '/' ? '' : at}/${rest}`)
  for (const place of [input.root, ...command.writableRoots]) {
    if (isInside(place, path, 'linux')) places.push(below(sandboxPath(place, command), relative(place, path)))
  }
  for (const mount of command.mounts ?? []) {
    if (isInside(mount.source, path, 'linux')) places.push(below(mount.target, relative(mount.source, path)))
  }
  if (input.fixed.some(place => isInside(place, path, 'linux'))) places.push(path)
  return [...new Set(places)]
}

/**
 * What every sandboxed command is given (Q11), never inherited from the node: PATH through the Node install, the
 * node's toolchains (each folder and its `bin`), and the system folders; the user `agent`; `/bin/sh`; and `/tmp`. A
 * call's own `env` is set over them.
 */
function sandboxEnvironment(nodePrefix: string, readOnlyPaths: readonly string[]): Record<string, string> {
  const toolchains = readOnlyPaths.flatMap(path => [join(path, 'bin'), path])
  const path = [...new Set([join(nodePrefix, 'bin'), ...toolchains, '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'])]
  return { PATH: path.join(':'), USER: SANDBOX_USER, LOGNAME: SANDBOX_USER, SHELL: '/bin/sh', TMPDIR: '/tmp' }
}

interface SandboxEtc { passwd: string; group: string; hosts: string }

/** The sandbox's hosts file: the loopback and the sandbox's own name, so the name `--hostname` gives resolves, and the machine's names never show. */
export const SANDBOX_HOSTS = `127.0.0.1 localhost\n127.0.1.1 ${SANDBOX_HOSTNAME}\n::1 localhost ip6-localhost ip6-loopback\n`

/**
 * The sandbox's own /etc files: the account files, naming the user and group the command runs as (the caller's, mapped
 * into the user namespace) `agent`, with the sandbox home, so `whoami`, `id`, and a library's user lookup answer
 * `agent`; and the hosts file (SANDBOX_HOSTS). Written once per runtime, owner-only folder, files readable as /etc
 * files are.
 */
function writeSandboxEtc(directory: string): SandboxEtc {
  const uid = process.getuid?.() ?? 1000
  const gid = process.getgid?.() ?? 1000
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const passwd = join(directory, 'passwd')
  const group = join(directory, 'group')
  const hosts = join(directory, 'hosts')
  writeFileSync(passwd, `${SANDBOX_USER}:x:${uid}:${gid}:${SANDBOX_USER}:${SANDBOX_HOME}:/bin/sh\n`, { mode: 0o644 })
  writeFileSync(group, `${SANDBOX_USER}:x:${gid}:\n`, { mode: 0o644 })
  writeFileSync(hosts, SANDBOX_HOSTS, { mode: 0o644 })
  for (const file of [passwd, group, hosts]) setMode(file, 0o644)
  return { passwd, group, hosts }
}

function sandboxPath(path: string, command: SandboxCommand): string {
  if (!command.mount) return path
  const relativePath = relative(command.mount.root, path)
  if (!relativePath) return command.mount.at
  return relativePath === '..' || relativePath.startsWith('../') ? path : `${command.mount.at}/${relativePath}`
}
