import type { Sandbox, SandboxCommand } from '../../ports/sandbox.js'

/** macOS Seatbelt: reads allowed, writes confined to the granted roots. */
export function createSeatbeltSandbox(): Sandbox {
  return {
    mode: 'seatbelt',
    wrap: command => ({
      command: '/usr/bin/sandbox-exec',
      args: ['-p', buildProfile(command), command.command, ...command.args],
    }),
  }
}

function buildProfile(command: SandboxCommand): string {
  const writable = command.writableRoots.map(root => `(subpath ${quote(root)})`).join(' ')
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec process-fork sysctl-read mach-lookup)',
    '(allow file-read*)',
    `(allow file-write* (subpath "/private/tmp") (subpath "/tmp")${writable ? ` ${writable}` : ''})`,
    command.allowNetwork ? '(allow network*)' : '(deny network*)',
  ].join('\n')
}

function quote(value: string): string {
  return `"${value.replace(/(["\\])/g, '\\$1')}"`
}
