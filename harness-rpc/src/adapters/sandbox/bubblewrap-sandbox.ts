import type { Sandbox, SandboxCommand } from '../../ports/sandbox.js'

/** Linux namespace isolation: whole filesystem read-only, writable roots bound back in. */
export function createBubblewrapSandbox(bwrapPath: string): Sandbox {
  return {
    mode: 'bubblewrap',
    wrap: command => ({ command: bwrapPath, args: buildArgs(command) }),
  }
}

function buildArgs(command: SandboxCommand): string[] {
  const args = [
    '--die-with-parent',
    '--unshare-user',
    '--unshare-pid',
    '--unshare-uts',
    '--unshare-ipc',
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
  ]
  if (!command.allowNetwork) args.push('--unshare-net')
  for (const root of command.writableRoots) args.push('--bind', root, root)
  args.push('--chdir', command.cwd, '--', command.command, ...command.args)
  return args
}
