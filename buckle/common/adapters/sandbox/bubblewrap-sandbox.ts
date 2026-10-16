import { SANDBOX_HOME } from '../../domain/sandbox-mounts.js'
import { dirname, relative } from 'pathe'
import type { Sandbox, SandboxCommand } from '../../types/ports/sandbox.js'

export function createBubblewrapSandbox(bwrapPath: string, options: { nodePrefix?: string } = {}): Sandbox {
  const nodePrefix = options.nodePrefix ?? dirname(dirname(process.execPath))
  return { mode: 'bubblewrap', supportsMount: true, wrap: command => ({ command: bwrapPath, args: buildArgs(command, nodePrefix) }) }
}

const SYSTEM_PATHS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc/ld.so.cache', '/etc/nsswitch.conf', '/etc/resolv.conf', '/etc/hosts', '/etc/ssl/certs', '/etc/passwd', '/etc/group', '/etc/localtime']

function buildArgs(command: SandboxCommand, nodePrefix: string): string[] {
  const args = ['--die-with-parent', '--unshare-user', '--unshare-pid', '--unshare-uts', '--unshare-ipc']
  if (command.commandIsPid1) args.push('--as-pid-1')
  if (!command.allowNetwork) args.push('--unshare-net')
  for (const path of new Set([...SYSTEM_PATHS, nodePrefix, ...command.readOnlyPaths])) args.push('--ro-bind-try', path, path)
  args.push('--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--dir', SANDBOX_HOME, '--setenv', 'HOME', SANDBOX_HOME)
  const root = command.workspaceRoot ?? command.mount?.root ?? command.writableRoots[0] ?? command.cwd
  args.push('--ro-bind', root, sandboxPath(root, command))
  for (const path of command.writableRoots) args.push('--bind', path, sandboxPath(path, command))
  for (const path of command.readOnlyWorkspacePaths ?? []) args.push('--ro-bind', path, sandboxPath(path, command))
  for (const path of command.hiddenPaths) args.push('--tmpfs', sandboxPath(path, command))
  for (const path of command.hiddenFiles ?? []) args.push('--ro-bind', '/dev/null', sandboxPath(path, command))
  for (const mount of command.mounts ?? []) args.push(mount.readOnly ? '--ro-bind' : '--bind', mount.source, mount.target)
  args.push('--chdir', sandboxPath(command.cwd, command), '--', command.command, ...command.args)
  return args
}

function sandboxPath(path: string, command: SandboxCommand): string {
  if (!command.mount) return path
  const relativePath = relative(command.mount.root, path)
  if (!relativePath) return command.mount.at
  return relativePath === '..' || relativePath.startsWith('../') ? path : `${command.mount.at}/${relativePath}`
}
