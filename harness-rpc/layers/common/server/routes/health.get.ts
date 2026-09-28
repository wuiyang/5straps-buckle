import { defineHandler } from 'h3'
import { PROTOCOL_VERSION } from '@5straps/protocol'
import { useServices } from '../utils/services.js'

// Liveness: open, and answers during startup too; it reports nothing a caller could act on.
export default defineHandler(event => ({ status: 'ok', serverId: useServices(event).nodeIdentity().serverId, protocolVersion: PROTOCOL_VERSION }))
