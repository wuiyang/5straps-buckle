import type { SandboxMode } from '@5straps/protocol'
import { findExecutable, resolveProgram, type ProgramSearch } from '../../domain/executable.js'
import type { Sandbox } from '../../types/ports/sandbox.js'
import { logger } from '../../runtime/log.js'
import { createBubblewrapSandbox } from './bubblewrap-sandbox.js'
import { createNoneSandbox } from './none-sandbox.js'
import { createSeatbeltSandbox, SANDBOX_EXEC } from './seatbelt-sandbox.js'

export interface SandboxResolution {
  sandbox: Sandbox
  /**
   * Set when commands cannot be sandboxed here. Buckle still starts and every other pack works;
   * only the shell pack goes unavailable, carrying this reason.
   */
  unavailableReason: string | null
}

/**
 * The only place a sandbox implementation is chosen. The sandbox program (bwrap, or macOS's sandbox-exec) is resolved
 * as every program Buckle runs is (resolveProgram): one found inside the workspace or a scratch root (`untrustedRoots`),
 * as `npx` and `pnpm exec` put `<ws>/node_modules/.bin` first on PATH, would be the sandbox of every command, so it is
 * refused, and then no sandbox is available: the shell tools are withheld with the reason, never run without one.
 */
export function resolveSandbox(input: {
  requested: SandboxMode | 'auto'
  acknowledgedUnsandboxed: boolean
  untrustedRoots: readonly string[]
} & ProgramSearch): SandboxResolution {
  const platform = input.platform ?? process.platform
  const search = { ...input, platform }
  const detected = input.requested === 'auto' ? detectMode(search) : input.requested

  if (detected === 'bubblewrap') {
    const bwrap = resolveProgram('bwrap', search)
    if (bwrap.path !== null) return { sandbox: createBubblewrapSandbox(bwrap.path), unavailableReason: null }
    if (bwrap.untrusted) return withheld(bwrap.reason)
    if (input.requested !== 'auto') {
      return unavailable('BUCKLE_SANDBOX=bubblewrap was requested but bwrap is not installed')
    }
  }

  if (detected === 'seatbelt') {
    if (platform === 'darwin') {
      const sandboxExec = resolveProgram(SANDBOX_EXEC, search)
      if (sandboxExec.path !== null) return { sandbox: createSeatbeltSandbox(sandboxExec.path), unavailableReason: null }
      return withheld(sandboxExec.reason)
    }
    if (input.requested !== 'auto') {
      return unavailable(`BUCKLE_SANDBOX=seatbelt was requested but this is ${platform}, not macOS`)
    }
  }

  if (input.acknowledgedUnsandboxed) {
    logger.warn('Running commands without a process sandbox', { platform })
    return { sandbox: createNoneSandbox(), unavailableReason: null }
  }

  return unavailable(
    'No process sandbox is available here, so shell tools are withheld. '
    + 'Install bubblewrap (Linux) or set BUCKLE_SANDBOX=none to run commands unsandboxed on purpose.',
  )
}

function unavailable(reason: string): SandboxResolution {
  return { sandbox: createNoneSandbox(), unavailableReason: reason }
}

/** The sandbox program was refused or is missing: no command runs without it. */
function withheld(reason: string): SandboxResolution {
  return unavailable(`${reason}; no process sandbox is available, so shell tools are withheld`)
}

/** Which sandbox `auto` means: seatbelt on macOS, and bubblewrap on Linux wherever PATH has a bwrap, trusted or not. */
function detectMode(search: ProgramSearch & { platform: NodeJS.Platform }): SandboxMode {
  if (search.platform === 'darwin') return 'seatbelt'
  if (search.platform === 'linux' && (search.lookup ?? findExecutable)('bwrap', search.environment ?? process.env, search.platform) !== null) return 'bubblewrap'
  return 'none'
}
