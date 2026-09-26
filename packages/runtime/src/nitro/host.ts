import type { NitroApp } from 'nitro/types'
import { RuntimeError } from '../errors.js'
import type { RuntimeOwner } from '../lifecycle/owner.js'
import type { Logger } from '../logger/types.js'

// Each backend augments this with its typed accessors, e.g. getAuditService(): AuditService.
export interface RuntimeServices {}

export interface RuntimeHost {
  owner: RuntimeOwner
  services: RuntimeServices
  logger: Logger
}

export const NitroErrorCode = Object.freeze({
  hostBound: 'RuntimeHostAlreadyBoundError',
  cliListenerRegistered: 'CliListenerAlreadyRegisteredError',
  hooksUnavailable: 'NitroHooksUnavailableError',
  identityOverwrite: 'GuardIdentityOverwriteError',
} as const)

// Stored on the app object under a registered symbol so a bundled copy of this package in
// Nitro's output and main.ts's copy see the same slot. Per app, never process-global.
const HOST_SLOT = Symbol.for('@5straps/runtime/host')
type HostSlot = { [HOST_SLOT]?: RuntimeHost }

export function bindHost(nitroApp: NitroApp, host: RuntimeHost): () => void {
  const slot = nitroApp as NitroApp & HostSlot
  if (slot[HOST_SLOT]) throw new RuntimeError(NitroErrorCode.hostBound, 'A runtime host is already bound to this Nitro app')
  slot[HOST_SLOT] = host
  return () => { if (slot[HOST_SLOT] === host) delete slot[HOST_SLOT] }
}

export function useHost(nitroApp: NitroApp): RuntimeHost | undefined {
  return (nitroApp as NitroApp & HostSlot)[HOST_SLOT]
}
