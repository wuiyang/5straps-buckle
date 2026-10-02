import type { SandboxMount } from '../../domain/sandbox-mounts.js'
import type { SandboxMode } from '@5straps/protocol'

export interface SandboxCommand {
  mounts?: SandboxMount[]
  command: string
  args: string[]
  /** The real working directory. A mounted sandbox translates it to the virtual one. */
  cwd: string
  /** Directories the process may write to. Everything else is read-only or hidden. */
  writableRoots: string[]
  allowNetwork: boolean
  commandIsPid1?: boolean
  /** Present the workspace root at a virtual path and hide the rest of the host. */
  mount: { root: string; at: string } | null
  /** Host paths a command must not see, Buckle's own state above all. */
  hiddenPaths: string[]
  hiddenFiles?: string[]
  readOnlyWorkspacePaths?: string[]
  workspaceRoot?: string
  /** Host directories a mounted command may still read, for toolchains living outside the system directories. */
  readOnlyPaths: string[]
}

export interface Sandbox {
  readonly mode: SandboxMode
  /** Whether `mount` is honoured. Where it is not, shell tools are withheld rather than shown a different view. */
  readonly supportsMount: boolean
  /** Rewrites a command so the platform sandbox wraps it. */
  wrap(command: SandboxCommand): { command: string; args: string[] }
}
