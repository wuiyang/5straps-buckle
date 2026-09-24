import type { GrantScope } from '@5straps/protocol'
import type { PermissionRule } from './permission/decision.js'
import { hostSubject } from './permission/rules/network-egress-rule.js'
import { compileUrlPatterns, matchingHostEntry, type UrlMatcher } from './url-pattern.js'

export type UrlVerdictKind = 'approved' | 'denied' | 'asks' | 'not listed'

export interface UrlVerdict {
  verdict: UrlVerdictKind
  /** The rule, list entry or grant that decided it, worded for one line. */
  because: string
}

/** A standing or unspent `network_egress` approval, with what to call it when it decides. */
export interface NetworkApproval {
  subject: string
  label: string
  /** Recorded through `buckle approve --host`; only then is the subject read as a pattern. */
  pattern?: boolean
}

export function describeGrantScope(scope: GrantScope): string {
  return scope === 'always' ? 'persisted approval' : `${scope} approval`
}

/**
 * What the network rules would answer for one URL, for `buckle check-url`. The verdict is the
 * egress rule's own, taken with its approved list from the runtime that builds them for the
 * engine and the packs, so it cannot drift from what a call meets. The two lists are read only
 * to name the entries that matched.
 *
 * `BUCKLE_ALLOWED_HOSTS` is not read by the rule. `web_fetch` consults it after the rule, to reach
 * a listed host even where its name resolves to a private address, so it decides only what the
 * rule allowed and never answers the question the rule asks.
 */
export function judgeUrl(input: {
  url: URL
  rule: PermissionRule
  approved: UrlMatcher | null
  workspaceList: string[]
  nodeList: string[] | null
  allowedHosts: string[]
  approvals: NetworkApproval[]
}): UrlVerdict {
  const decision = input.rule.evaluate({
    tool: 'check-url',
    effect: { kind: 'network', url: input.url },
    grants: {
      subjectsFor: rule => rule === 'network_egress' ? input.approvals.filter(approval => !approval.pattern).map(approval => approval.subject) : [],
      patternsFor: rule => rule === 'network_egress' ? input.approvals.filter(approval => approval.pattern).map(approval => approval.subject) : [],
    },
  })
  const listedHost = matchingHostEntry(input.allowedHosts, input.url)

  if (!decision || decision.kind === 'deny') return { verdict: 'denied', because: `network_egress: ${decision?.reason ?? 'refused'}` }
  if (decision.kind === 'ask') {
    const note = listedHost ? `; BUCKLE_ALLOWED_HOSTS lists ${listedHost}, which answers no question` : ''
    return { verdict: 'asks', because: `network_egress: ${decision.reason}${note}` }
  }
  if (decision.via) {
    const exact = decision.via.subject === hostSubject(input.url)
    const approval = input.approvals.find(entry => entry.subject === decision.via!.subject && Boolean(entry.pattern) === !exact)
    const covered = exact ? decision.via.subject : `pattern ${decision.via.subject}, which covers ${hostSubject(input.url)}`
    return { verdict: 'approved', because: `${approval?.label ?? 'approval'} for ${covered}` }
  }
  if (input.approved) return { verdict: 'approved', because: matchingEntries({ url: input.url, workspaceList: input.workspaceList, nodeList: input.nodeList }) }
  if (listedHost) return { verdict: 'approved', because: `BUCKLE_ALLOWED_HOSTS entry ${listedHost}` }
  return { verdict: 'not listed', because: 'no approved list is set, so a public host is reached without asking; web_fetch still refuses one that resolves to a private address' }
}

function matchingEntries(input: { url: URL; workspaceList: string[]; nodeList: string[] | null }): string {
  const first = (list: string[]) => list.find(pattern => compileUrlPatterns([pattern]).matches(input.url))
  const parts = [
    ...(input.workspaceList.length ? [`approved list entry ${first(input.workspaceList)}`] : []),
    ...(input.nodeList?.length ? [`node approved list entry ${first(input.nodeList)}`] : []),
  ]
  return parts.join(' and ')
}

