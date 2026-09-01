import type { SandboxMode } from '@5straps/protocol'

export interface SandboxCommand {
  command: string
  args: string[]
  cwd: string
  /** Directories the process may write to. Everything else is read-only or hidden. */
  writableRoots: string[]
  allowNetwork: boolean
}

export interface Sandbox {
  readonly mode: SandboxMode
  /** Rewrites a command so the platform sandbox wraps it. */
  wrap(command: SandboxCommand): { command: string; args: string[] }
}
