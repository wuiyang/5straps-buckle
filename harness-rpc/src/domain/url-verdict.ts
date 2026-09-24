import type { GrantScope } from '@5straps/protocol'
import { createNetworkEgressRule } from './permission/rules/network-egress-rule.js'
import { compileUrlPatterns, intersectUrlMatchers } from './url-pattern.js'

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
}

export function describeGrantScope(scope: GrantScope): string {
  return scope === 'always' ? 'persisted approval' : `${scope} approval`
}

/**
 * What the network rules would answer for one URL, for `buckle check-url`. The verdict is the
 * egress rule's own, built from the same lists the packs are given, so it cannot drift from what
 * a call meets: the workspace's approved list, intersected with the node's where a registered
 * workspace has one, then the private-address question and the approvals that answer it.
 *
 * `BUCKLE_ALLOWED_HOSTS` is not read by the rule. `web_fetch` consults it after the rule, to reach
 * a listed host even where its name resolves to a private address, so it decides only what the
 * rule allowed and never answers the question the rule asks.
 */
export function judgeUrl(input: {
  url: URL
  workspaceList: string[]
  nodeList: string[] | null
  allowedHosts: string[]
  approvals: NetworkApproval[]
}): UrlVerdict {
  const workspace = input.workspaceList.length ? compileUrlPatterns(input.workspaceList) : null
  const node = input.nodeList?.length ? compileUrlPatterns(input.nodeList) : null
  const approved = intersectUrlMatchers(node, workspace)
  const decision = createNetworkEgressRule({ approved }).evaluate({
    tool: 'check-url',
    effect: { kind: 'network', url: input.url },
    grants: { subjectsFor: rule => rule === 'network_egress' ? input.approvals.map(approval => approval.subject) : [] },
  })
  const subject = hostSubject(input.url)
  const listedHost = input.allowedHosts.find(entry => entry === subject || entry === bareHost(input.url))

  if (!decision || decision.kind === 'deny') return { verdict: 'denied', because: `network_egress: ${decision?.reason ?? 'refused'}` }
  if (decision.kind === 'ask') {
    const note = listedHost ? `; BUCKLE_ALLOWED_HOSTS lists ${listedHost}, which answers no question` : ''
    return { verdict: 'asks', because: `network_egress: ${decision.reason}${note}` }
  }
  if (decision.via) {
    const approval = input.approvals.find(entry => entry.subject === decision.via!.subject)
    return { verdict: 'approved', because: `${approval?.label ?? 'approval'} for ${decision.via.subject}` }
  }
  if (approved) return { verdict: 'approved', because: matchingEntries({ url: input.url, workspaceList: input.workspaceList, nodeList: input.nodeList }) }
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

/** The subject the egress rule asks about and a grant names: the host, with a port when written. */
function hostSubject(url: URL): string {
  return url.port ? `${url.hostname}:${url.port}` : url.hostname
}

function bareHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '')
}
