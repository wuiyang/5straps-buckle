import { parseCidr, type AddressRange, type NodeListener } from '../domain/ip.js'
import type { BuckleConfig } from './config.js'

export function listenerOf(config: BuckleConfig): NodeListener {
  return { host: config.host, port: config.port }
}

/** The ranges in force, each checked when its setting was written or read, so parsing cannot fail here. */
export function privateRangesOf(config: BuckleConfig): AddressRange[] {
  return config.networkPrivateRanges.map(parseCidr)
}
