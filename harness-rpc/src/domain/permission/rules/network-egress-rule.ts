import { reservedRangeOf } from '../../ip.js'
import type { PermissionRule } from '../decision.js'
import { allowedVia, ask, deny } from '../decision.js'

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])
const LOCAL_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback'])

/**
 * Judges the URL as written. A hostname can still resolve into a reserved range, so the
 * fetch adapter re-checks every resolved address and every redirect hop with `reservedRangeOf`.
 */
export function createNetworkEgressRule(): PermissionRule {
  return {
    id: 'network_egress',
    evaluate({ effect, grants }) {
      if (effect.kind !== 'network') return null
      const url = effect.url
      if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
        return deny('network_egress', url.protocol, `Only http and https are allowed, got ${url.protocol}`)
      }

      const reason = localReason(url.hostname)
      if (!reason) return { kind: 'allow' }

      const subject = url.port ? `${url.hostname}:${url.port}` : url.hostname
      if (grants.subjectsFor('network_egress').includes(subject)) return allowedVia('network_egress', subject)
      return ask('network_egress', subject, reason)
    },
  }
}

function localReason(hostname: string): string | null {
  const bare = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (LOCAL_HOSTNAMES.has(bare) || bare.endsWith('.localhost')) return `${bare} resolves to this machine`
  const range = reservedRangeOf(bare)
  return range ? `${bare} is in the ${range} range` : null
}
