import { PROTOCOL_VERSION } from '@5straps/protocol'
import type { H3Event } from 'h3'
import { useServices } from './services.js'

/** What liveness reports, from configuration alone; nothing a caller could act on. */
export function health(event: H3Event): { status: 'ok'; serverId: string; protocolVersion: string } {
  return { status: 'ok', serverId: useServices(event).nodeIdentity().serverId, protocolVersion: PROTOCOL_VERSION }
}
