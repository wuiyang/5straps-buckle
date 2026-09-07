import { reservedRangeOf } from '../../ip.js'
import type { UrlMatcher } from '../../url-pattern.js'
import type { PermissionRule } from '../decision.js'
import { allowedVia, ask, deny } from '../decision.js'

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])
const LOCAL_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback'])

export interface NetworkEgressOptions {
  /**
   * The owner's approved list. When present, only what it names may be reached, and a listed
   * private address is reached without asking: the owner already said so.
   */
  approved: UrlMatcher | null
}

/**
 * Judges the URL as written. A hostname can still resolve into a reserved range, so the
 * fetch adapter re-checks every resolved address and every redirect hop with `reservedRangeOf`.
 */
export function createNetworkEgressRule(options: NetworkEgressOptions = { approved: null }): PermissionRule {
  return {
    id: 'network_egress',
    evaluate({ effect, grants }) {
      if (effect.kind !== 'network') return null
      const url = effect.url
      if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
        return deny('network_egress', url.protocol, `Only http and https are allowed, got ${url.protocol}`)
      }

      const subject = url.port ? `${url.hostname}:${url.port}` : url.hostname
      if (options.approved) {
        if (options.approved.matches(url)) return { kind: 'allow' }
        return deny('network_egress', subject, `${url.origin} is not on the workspace's approved list. Approved: ${options.approved.patterns.join(', ')}`)
      }

      const reason = localReason(url.hostname)
      if (!reason) return { kind: 'allow' }
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
