import type { ApprovalRequest, JsonValue } from '@5straps/protocol'
import { callDigestOf, canonicalJson, challengeBytes, shownCallDigestOf, SIGNED_REQUEST_VERSION, WORKSPACE_NAME_MAX, type ApprovalChallenge, type ShownApprovalCall } from '@5straps/protocol/signed-request'
import { shownCall, type AskedCall } from './asked-call.js'
import type { PendingAsk } from './ledger-state.js'

/**
 * A whole shown call larger than this is not repeated inside each of its asks'
 * challenges: each carries its digest, and the listing carries the call once (review M1 of the slice 5 re-review).
 */
export const INLINE_CALL_BYTES = 16 * 1_024
/** Every waiting ask's challenge, with each large whole call carried once by its signed reference. */
export interface ChallengeListing {
  challenges: Array<{ token: string; challenge: ApprovalChallenge | null }>
  calls: Record<string, ShownApprovalCall>
}

/** A waiting request as a listing carries it: `callRef` on every ask of a group, the group's whole call on its first. */
export type ListedApproval = ApprovalRequest & {
  callRef?: string
  /** `judge`: what the decision AI said of the call's interpreter asks (D91), a listing's field of Buckle's own. */
  call?: { arguments: JsonValue; cwd: string; description: string | null; effects: string[]; judge?: AskedCall['judge'] }
}

/**
 * The waiting asks with each request group's whole call once (review M1 of the slice 5 re-review): every ask of a
 * group names it by `callRef`, and the group's first ask listed carries it, as each ask did before this build,
 * so a reader of `call` alone still finds it there. A complete call kept inline (asks recorded by 077ca3e to
 * f931286) is carried whole with its ask (review L5 of the continuation review). An ask recorded before those
 * builds has neither.
 */
export function listedApprovals(waiting: readonly PendingAsk[]): ListedApproval[] {
  const carried = new Set<string>()
  return waiting.map(({ request, call, callRef }) => {
    const whole = shownCall(call)
    const shown = whole && call?.judge ? { ...whole, judge: call.judge } : whole
    if (!shown) return { ...request }
    if (callRef === undefined) return { ...request, call: shown }
    const first = !carried.has(callRef)
    carried.add(callRef)
    return { ...request, callRef, ...(first ? { call: shown } : {}) }
  })
}

export interface ApprovalChallengeIdentity {
  workspaceId: string
  serverId: string
  readonly workspaceName?: string
}

export function createApprovalChallenges(identity: ApprovalChallengeIdentity) {
  return { listing: challengeListing, shownDigests }

  function challengeListing(waiting: readonly PendingAsk[], listing?: { workspaceName?: boolean; widerSubject?: boolean }): ChallengeListing {
    const shown = createCallShapes()
    const calls: ChallengeListing['calls'] = {}
    const challenges = waiting.map((ask) => {
      const challenge = challengeOf(ask, shown, { named: listing?.workspaceName === true, wider: listing?.widerSubject === true })
      if (challenge?.callRef !== undefined && ask.call) calls[challenge.callRef] = shownCallOf(challenge.tool, ask.call)
      return { token: ask.request.token, challenge }
    })
    return { challenges, calls }
  }

  /**
   * The digests of the challenges a device may have been shown for an ask, with the workspace's name and without it, and
   * with its wider subject and without it; a decision that grants the wider subject counts only those that showed it.
   */
  function shownDigests(ask: PendingAsk, widens: boolean): string[] {
    const shapes = createCallShapes()
    const wider = widens ? [true] : [false, true]
    return [...new Set([false, true].flatMap(named => wider.flatMap((showsWider) => {
      const shown = challengeOf(ask, shapes, { named, wider: showsWider })
      return shown === null || (widens && shown.widerSubject === undefined) ? [] : [challengeBytes(shown).digest]
    })))]
  }

  // Each challenge signs either the whole inline call or the digest of every shared display field. The workspace's name is
  // read as it is signed, so a rename shows, and travels beside its id for a device that asked for it to show (D85, Q15);
  // the ask's wider subject travels for a device that asked for it, which may grant it (APPROVAL-37).
  function challengeOf(ask: PendingAsk, shapes: CallShapes, view: { named: boolean; wider: boolean } = { named: false, wider: false }): ApprovalChallenge | null {
    const { request, call } = ask
    if (!call?.complete) return null
    const { digest, callRef, inline } = shapes(request.tool, call)
    const name = view.named ? identity.workspaceName : undefined
    return {
      v: SIGNED_REQUEST_VERSION, purpose: 'buckle-approval-challenge', node: identity.serverId, workspace: identity.workspaceId,
      ...(name && name.length <= WORKSPACE_NAME_MAX ? { workspaceName: name } : {}),
      token: request.token, requestId: ask.requestId ?? null, sessionId: ask.sessionId, actor: ask.actor ?? null,
      tool: request.tool, rule: request.rule, subject: request.subject, reason: request.reason, offeredScopes: request.offeredScopes,
      ...(view.wider && request.widerSubject !== undefined ? { widerSubject: request.widerSubject } : {}),
      arguments: inline ? call.arguments : null, cwd: inline ? call.cwd : null, callDigest: digest,
      ...(inline ? {} : { callRef }),
      description: inline ? call.description : null, effects: inline ? call.effects ?? [] : null, expiresAt: request.expiresAt,
    }
  }

}

type CallShape = { digest: string; callRef: string; inline: boolean }
type CallShapes = (tool: string, call: AskedCall) => CallShape

function createCallShapes(): CallShapes {
  const known = new WeakMap<AskedCall, Map<string, CallShape>>()
  return (tool, call) => {
    const byTool = known.get(call) ?? new Map<string, CallShape>()
    known.set(call, byTool)
    const cached = byTool.get(tool)
    if (cached) return cached
    const shown = shownCallOf(tool, call)
    const shape = { digest: callDigestOf(shown), callRef: shownCallDigestOf(shown), inline: Buffer.byteLength(canonicalJson(shown)) <= INLINE_CALL_BYTES }
    byTool.set(tool, shape)
    return shape
  }
}

function shownCallOf(tool: string, call: AskedCall): ShownApprovalCall {
  return { tool, arguments: call.arguments, cwd: call.cwd, description: call.description, effects: call.effects ?? [] }
}
