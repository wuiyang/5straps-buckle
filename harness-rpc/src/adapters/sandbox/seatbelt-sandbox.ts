import type { Sandbox, SandboxCommand } from '../../ports/sandbox.js'

/** macOS Seatbelt: reads allowed, writes confined to the granted roots, Buckle's own state denied. */
export function createSeatbeltSandbox(): Sandbox {
  return {
    mode: 'seatbelt',
    // Seatbelt cannot present a directory under another name, so a mounted workspace withholds shell here.
    supportsMount: false,
    wrap: command => ({
      command: '/usr/bin/sandbox-exec',
      args: ['-p', buildProfile(command), command.command, ...command.args],
    }),
  }
}

function buildProfile(command: SandboxCommand): string {
  const writable = command.writableRoots.map(root => `(subpath ${quote(root)})`).join(' ')
  const hidden = command.hiddenPaths.map(path => `(deny file-read* file-write* (subpath ${quote(path)}))`)
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec process-fork sysctl-read mach-lookup)',
    '(allow file-read*)',
    `(allow file-write* (subpath "/private/tmp") (subpath "/tmp")${writable ? ` ${writable}` : ''})`,
    ...hidden,
    command.allowNetwork ? '(allow network*)' : '(deny network*)',
  ].join('\n')
}

function quote(value: string): string {
  return `"${value.replace(/(["\\])/g, '\\$1')}"`
}
