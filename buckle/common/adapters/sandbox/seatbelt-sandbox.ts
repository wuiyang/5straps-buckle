import type { Sandbox, SandboxCommand } from '../../types/ports/sandbox.js'

/** macOS's sandbox tool, where the system keeps it. */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

/** `sandboxExec`: the path the sandbox tool was resolved to (resolveProgram), which every wrapped command spawns. */
export function createSeatbeltSandbox(sandboxExec: string = SANDBOX_EXEC): Sandbox {
  return { mode: 'seatbelt', supportsMount: false, wrap: command => ({ command: sandboxExec, args: ['-p', buildProfile(command), command.command, ...command.args] }) }
}

function buildProfile(command: SandboxCommand): string {
  const writable = command.writableRoots.map(root => `(subpath ${quote(root)})`).join(' ')
  const readable = ['/usr', '/bin', '/sbin', '/System', '/Library/Apple', '/private/etc/ssl/certs', '/private/etc/resolv.conf', '/private/etc/hosts', '/dev/null', '/dev/urandom', '/private/tmp', '/tmp', command.workspaceRoot ?? command.writableRoots[0] ?? command.cwd, ...command.readOnlyPaths]
  const hidden = [...command.hiddenPaths, ...command.hiddenFiles ?? []].map(path => `(deny file-read* file-write* (subpath ${quote(path)}))`)
  return [
    '(version 1)', '(deny default)', '(allow process-exec process-fork sysctl-read mach-lookup)',
    `(allow file-read* ${readable.map(path => `(subpath ${quote(path)})`).join(' ')})`,
    `(allow file-write* (subpath "/private/tmp") (subpath "/tmp")${writable ? ` ${writable}` : ''})`,
    ...(command.readOnlyWorkspacePaths ?? []).map(path => `(deny file-write* (subpath ${quote(path)}))`),
    ...hidden,
    command.allowNetwork ? '(allow network*)' : '(deny network*)',
  ].join('\n')
}

function quote(value: string): string {
  return `"${value.replace(/(["\\])/g, '\\$1')}"`
}
