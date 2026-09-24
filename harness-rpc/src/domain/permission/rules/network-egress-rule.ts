import { reservedRangeOf } from '../../ip.js'
import { isHostWildcard, matchingHostEntry, type UrlMatcher } from '../../url-pattern.js'
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

      const subject = hostSubject(url)
      if (options.approved) {
        if (options.approved.matches(url)) return { kind: 'allow' }
        return deny('network_egress', subject, `${url.origin} is not on the workspace's approved list. Approved: ${options.approved.patterns.join(', ')}`)
      }

      const reason = localReason(url.hostname)
      if (!reason) return { kind: 'allow' }
      const covering = coveringGrant(grants.subjectsFor('network_egress'), url)
      if (covering) return allowedVia('network_egress', covering)
      return ask('network_egress', subject, reason)
    },
  }
}

/** The subject the rule asks about and an exact grant names: the host, with a port when written. */
export function hostSubject(url: URL): string {
  return url.port ? `${url.hostname}:${url.port}` : url.hostname
}

/**
 * The grant that covers a URL: one for its exact host first, then a pattern the owner widened an
 * approval to, per `BUCKLE-D18: A host wildcard covers the apex and every subdomain, in lists and
 * grants alike`. An exact subject is compared as it was recorded and never read as a pattern, so
 * `localhost`, granted for a URL with no port, still does not cover `localhost:5432`.
 */
export function coveringGrant(subjects: string[], url: URL): string | null {
  const subject = hostSubject(url)
  if (subjects.includes(subject)) return subject
  return matchingHostEntry(subjects.filter(isHostWildcard), url)
}

function localReason(hostname: string): string | null {
  const bare = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (LOCAL_HOSTNAMES.has(bare) || bare.endsWith('.localhost')) return `${bare} resolves to this machine`
  const range = reservedRangeOf(bare)
  return range ? `${bare} is in the ${range} range` : null
}
