import { dirname, relative } from 'node:path'
import type { Sandbox, SandboxCommand } from '../../ports/sandbox.js'

/**
 * Linux namespace isolation. Unmounted: the whole filesystem read-only with the writable roots
 * bound back in. Mounted: only the system directories, the workspace at its virtual path and
 * the named extras exist at all, so `/home` and the rest of the host are not there to be read.
 */
export function createBubblewrapSandbox(bwrapPath: string, options: { nodePrefix?: string } = {}): Sandbox {
  const nodePrefix = options.nodePrefix ?? dirname(dirname(process.execPath))
  return {
    mode: 'bubblewrap',
    supportsMount: true,
    wrap: command => ({ command: bwrapPath, args: buildArgs(command, nodePrefix) }),
  }
}

/** What a mounted command still needs of the host: binaries, libraries, configuration. */
const SYSTEM_DIRECTORIES = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/opt', '/var', '/nix', '/snap']

/** Everything writable that a home directory would normally absorb goes to a scratch home instead. */
const SCRATCH_HOME = '/tmp/home'

function buildArgs(command: SandboxCommand, nodePrefix: string): string[] {
  const args = ['--die-with-parent', '--unshare-user', '--unshare-pid', '--unshare-uts', '--unshare-ipc']
  if (!command.allowNetwork) args.push('--unshare-net')

  if (command.mount) {
    for (const directory of SYSTEM_DIRECTORIES) args.push('--ro-bind-try', directory, directory)
    for (const directory of [nodePrefix, ...command.readOnlyPaths]) args.push('--ro-bind-try', directory, directory)
    args.push('--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--dir', SCRATCH_HOME, '--setenv', 'HOME', SCRATCH_HOME)
    args.push('--bind', command.mount.root, command.mount.at)
    for (const root of command.writableRoots) {
      if (root !== command.mount.root) args.push('--bind-try', root, root)
    }
  } else {
    args.push('--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp')
    for (const root of command.writableRoots) args.push('--bind', root, root)
  }

  // Masked after the binds, so a hidden path inside a writable root stays hidden.
  for (const path of command.hiddenPaths) args.push('--tmpfs', path)

  args.push('--chdir', workingDirectory(command), '--', command.command, ...command.args)
  return args
}

function workingDirectory(command: SandboxCommand): string {
  if (!command.mount) return command.cwd
  const fromRoot = relative(command.mount.root, command.cwd)
  if (fromRoot === '') return command.mount.at
  return fromRoot.startsWith('..') ? command.cwd : `${command.mount.at}/${fromRoot}`
}
