import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'pathe'
import { SANDBOX_HOME } from '../../domain/sandbox-mounts.js'
import { isInside } from '../../domain/paths.js'
import type { Sandbox, SandboxCommand } from '../../types/ports/sandbox.js'
import { setMode } from '../file-modes.js'

/** Who and where a sandboxed command is (Q11 of the workspace-model brief): the user `agent` on the host `buckle`. */
export const SANDBOX_USER = 'agent'
export const SANDBOX_HOSTNAME = 'buckle'

/**
 * `identityDirectory`: where the sandbox's own /etc/passwd and /etc/group are written, naming the command's user
 * `agent`, so the owner's account and its home never show; without one, neither file is bound. `nodePrefix`: the Node
 * Buckle runs on, bound at its own path; the host's unless a test names one.
 */
export function createBubblewrapSandbox(bwrapPath: string, options: { nodePrefix?: string; identityDirectory?: string } = {}): Sandbox {
  const nodePrefix = options.nodePrefix ?? dirname(dirname(process.execPath))
  const identity = options.identityDirectory === undefined ? null : writeIdentity(options.identityDirectory)
  return {
    mode: 'bubblewrap',
    supportsMount: true,
    wrap: command => ({ command: bwrapPath, args: buildArgs(command, nodePrefix, identity) }),
    environment: readOnlyPaths => sandboxEnvironment(nodePrefix, readOnlyPaths),
  }
}

/**
 * The system folders every sandbox binds at their own path (D85, Q1, ruled "present but unlisted"): the kernel opens a
 * program's loader at a fixed path (`/lib64/ld-linux-x86-64.so.2`), and scripts need `/bin/sh` and `/usr/bin/env`.
 * `ls /` shows them; no mount table lists them.
 */
const SYSTEM_FOLDERS = ['/usr', '/bin', '/sbin', '/lib', '/lib64']

/** The files /etc is built from: the loader's cache, name lookup, certificates, and the time zone; never the host's accounts. */
const ETC_FILES = ['/etc/ld.so.cache', '/etc/nsswitch.conf', '/etc/resolv.conf', '/etc/hosts', '/etc/ssl/certs', '/etc/pki/tls/certs', '/etc/pki/ca-trust/extracted', '/etc/localtime']

/**
 * The bubblewrap layout (Phase 2 item 3, Q11): an empty root (`--tmpfs /`), the system folders and the chosen /etc
 * files, the Node install and the node's toolchains at their own paths, `--dev`, `--proc`, `--tmpfs /tmp` with the
 * sandbox home, the workspace's folder and each mount at its target, and the host named `buckle`. A mask over hidden
 * state is laid only where that state would show (inside something bound), at the path it shows at, so no folder of
 * the owner's (`/home/<owner>/.5straps`) is made to hold one. `/proc/self/mountinfo` still names each bind's source,
 * which no layout hides (a known limit).
 */
function buildArgs(command: SandboxCommand, nodePrefix: string, identity: Identity | null): string[] {
  const args = ['--die-with-parent', '--unshare-user', '--unshare-pid', '--unshare-uts', '--unshare-ipc']
  if (command.commandIsPid1) args.push('--as-pid-1')
  if (!command.allowNetwork) args.push('--unshare-net')
  args.push('--tmpfs', '/', '--hostname', SANDBOX_HOSTNAME)
  const fixed = [...new Set([...SYSTEM_FOLDERS, nodePrefix, ...command.readOnlyPaths])]
  for (const path of [...new Set([...SYSTEM_FOLDERS, ...ETC_FILES, nodePrefix, ...command.readOnlyPaths])]) args.push('--ro-bind-try', path, path)
  if (identity) args.push('--ro-bind', identity.passwd, '/etc/passwd', '--ro-bind', identity.group, '/etc/group')
  args.push('--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--dir', SANDBOX_HOME, '--setenv', 'HOME', SANDBOX_HOME)
  const root = command.workspaceRoot ?? command.mount?.root ?? command.writableRoots[0] ?? command.cwd
  args.push('--ro-bind', root, sandboxPath(root, command))
  for (const path of command.writableRoots) args.push('--bind', path, sandboxPath(path, command))
  for (const path of command.readOnlyWorkspacePaths ?? []) args.push('--ro-bind', path, sandboxPath(path, command))
  const shown = (path: string): string | null => shownAt(path, { command, root, fixed })
  for (const path of command.hiddenPaths) { const at = shown(path); if (at !== null) args.push('--tmpfs', at) }
  for (const path of command.hiddenFiles ?? []) { const at = shown(path); if (at !== null) args.push('--ro-bind', '/dev/null', at) }
  // After the masks: an approved sensitive file is bound over its own mask.
  for (const mount of command.mounts ?? []) args.push(mount.readOnly ? '--ro-bind' : '--bind', mount.source, mount.target)
  args.push('--chdir', sandboxPath(command.cwd, command), '--', command.command, ...command.args)
  return args
}

/**
 * Where a hidden host path shows inside the sandbox, or null where nothing bound holds it: inside the workspace's
 * folder or a writable root, at its sandbox path; inside a folder bound at its own path, there.
 */
function shownAt(path: string, input: { command: SandboxCommand; root: string; fixed: readonly string[] }): string | null {
  const { command } = input
  if ([input.root, ...command.writableRoots].some(place => isInside(place, path, 'linux'))) return sandboxPath(path, command)
  if (input.fixed.some(place => isInside(place, path, 'linux'))) return path
  return null
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

interface Identity { passwd: string; group: string }

/**
 * The sandbox's own account files, naming the user and group the command runs as (the caller's, mapped into the user
 * namespace) `agent`, with the sandbox home, so `whoami`, `id`, and a library's user lookup answer `agent`. Written
 * once per runtime, owner-only folder, files readable as /etc files are.
 */
function writeIdentity(directory: string): Identity {
  const uid = process.getuid?.() ?? 1000
  const gid = process.getgid?.() ?? 1000
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const passwd = join(directory, 'passwd')
  const group = join(directory, 'group')
  writeFileSync(passwd, `${SANDBOX_USER}:x:${uid}:${gid}:${SANDBOX_USER}:${SANDBOX_HOME}:/bin/sh\n`, { mode: 0o644 })
  writeFileSync(group, `${SANDBOX_USER}:x:${gid}:\n`, { mode: 0o644 })
  for (const file of [passwd, group]) setMode(file, 0o644)
  return { passwd, group }
}

function sandboxPath(path: string, command: SandboxCommand): string {
  if (!command.mount) return path
  const relativePath = relative(command.mount.root, path)
  if (!relativePath) return command.mount.at
  return relativePath === '..' || relativePath.startsWith('../') ? path : `${command.mount.at}/${relativePath}`
}
