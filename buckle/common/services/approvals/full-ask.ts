import { createHash } from 'node:crypto'
import type { ApprovalRequest } from '@5straps/protocol'
import type { AskedCall } from '../../domain/approval/asked-call.js'
import type { ApprovalHold, FullAsk } from '../../types/ports/approval-backend.js'
import type { PendingAsk } from './approval-registry.js'

/** Where an ask is shown from: its workspace, its call's group and key, and who asked. */
export interface AskSetting {
  /** `name` is read as the ask is shown, so a rename shows at once. */
  workspace: FullAsk['workspace']
  group: string
  idempotencyKey: string
  correlationId: string
  requestId: string
  actor: string | null
  sessionId: string
  hold: ApprovalHold | null
  /** The whole call, where it was kept whole: an ask without one can only be denied. */
  call?: AskedCall
}

export function fullAskOf(approval: ApprovalRequest, setting: AskSetting): FullAsk {
  const { call } = setting
  return {
    egress: 'full', contractVersion: 1, token: approval.token, group: setting.group, idempotencyKey: setting.idempotencyKey,
    correlation: { correlationId: setting.correlationId, requestId: setting.requestId },
    workspace: setting.workspace,
    requester: { actor: setting.actor, sessionId: setting.sessionId },
    tool: approval.tool,
    policy: { rule: approval.rule, subject: approval.subject, reason: approval.reason, offeredScopes: approval.offeredScopes, ...(approval.widerSubject === undefined ? {} : { widerSubject: approval.widerSubject }) },
    risk: { ...(approval.severity === undefined ? {} : { severity: approval.severity }), notes: call?.judge ?? [] },
    deadline: { expiresAt: approval.expiresAt, hold: setting.hold },
    ...(call === undefined ? {} : { action: { arguments: call.arguments, cwd: call.cwd, description: call.description, ...(call.effects === undefined ? {} : { effects: call.effects }) } }),
  }
}

/**
 * A waiting ask as the ledger keeps it, for a backend that reads the queue rather than being handed a call's asks: its
 * group is its call's file, and it carries no action where its whole call was not kept. No terminal holds it.
 */
export function ledgerAskOf(ask: PendingAsk, setting: { workspace: FullAsk['workspace']; idempotencyKey: (joinKey: string) => string }): FullAsk {
  const { request } = ask
  const requestId = ask.requestId ?? request.token
  return fullAskOf(request, {
    workspace: setting.workspace, group: ask.callRef ?? request.token, idempotencyKey: setting.idempotencyKey(joinKey({ sessionId: ask.sessionId, actor: ask.actor, requestId })),
    correlationId: requestId, requestId, actor: ask.actor ?? null, sessionId: ask.sessionId, hold: null,
    ...(ask.call?.complete ? { call: ask.call } : {}),
  })
}

/** The in-process twin of the registry's join: the same requestId, session and actor. */
export function joinKey(input: { sessionId: string; requestId: string; actor?: string }): string {
  return JSON.stringify([input.sessionId, input.actor ?? null, input.requestId])
}

/**
 * The name a call's hold gives its asks in the executing mark, which every process reads: the join key, hashed, so the
 * mark names the asks a re-send would join and holds no requestId.
 */
export function heldAskName(input: { sessionId: string; requestId: string; actor?: string }): string {
  return createHash('sha256').update(joinKey(input)).digest('base64url')
}
