import { platform } from 'node:os'
import type { SandboxMode } from '@5straps/protocol'
import { findExecutable } from '../../domain/executable.js'
import type { Sandbox } from '../../types/ports/sandbox.js'
import { logger } from '../../runtime/logger.js'
import { createBubblewrapSandbox } from './bubblewrap-sandbox.js'
import { createNoneSandbox } from './none-sandbox.js'
import { createSeatbeltSandbox } from './seatbelt-sandbox.js'

export interface SandboxResolution {
  sandbox: Sandbox
  /**
   * Set when commands cannot be sandboxed here. Buckle still starts and every other pack works;
   * only the shell pack goes unavailable, carrying this reason.
   */
  unavailableReason: string | null
}

/** The only place a sandbox implementation is chosen. */
export function resolveSandbox(input: {
  requested: SandboxMode | 'auto'
  acknowledgedUnsandboxed: boolean
}): SandboxResolution {
  const detected = input.requested === 'auto' ? detectMode() : input.requested

  if (detected === 'bubblewrap') {
    const bwrapPath = findExecutable('bwrap')
    if (bwrapPath) return { sandbox: createBubblewrapSandbox(bwrapPath), unavailableReason: null }
    if (input.requested !== 'auto') {
      return unavailable('BUCKLE_SANDBOX=bubblewrap was requested but bwrap is not installed')
    }
  }

  if (detected === 'seatbelt') {
    if (platform() === 'darwin') return { sandbox: createSeatbeltSandbox(), unavailableReason: null }
    if (input.requested !== 'auto') {
      return unavailable(`BUCKLE_SANDBOX=seatbelt was requested but this is ${platform()}, not macOS`)
    }
  }

  if (input.acknowledgedUnsandboxed) {
    logger.warn('Running commands without a process sandbox', { platform: platform() })
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

function detectMode(): SandboxMode {
  if (platform() === 'darwin') return 'seatbelt'
  if (platform() === 'linux' && findExecutable('bwrap')) return 'bubblewrap'
  return 'none'
}
