import { defineScoped, type CliRequest, type PendingInteraction, type RequestCli, type ScopedDefinition } from '@5straps/runtime'

/**
 * How long a gated call is held for an answer:
 * - `grace`: for `BUCKLE_APPROVAL_TIMEOUT_MS`, while any route may answer (serve and mcp). A terminal
 *   question still open when it ends keeps asking until the request expires or is answered.
 * - `prompt`: only while this process's own terminal asks (a CLI command); without one, not at all.
 */
export type ApprovalHold = 'grace' | 'prompt'

/**
 * How an operation reaches a person: the process's requester and the hold its transport chose.
 *
 * Only the hold is scoped. The requester is process-level, bound once by main on the common runtime,
 * because the approval service is a per-workspace singleton that keeps asking after a `grace` call
 * returns, and a singleton must not retain a scoped value (nitro/runtime.md, Lifetimes; review L2).
 */
export interface Interaction {
  readonly requestCli: RequestCli
  readonly hold: ApprovalHold
}

/** Bound once per operation scope by the transport that opened it; read by the approval service. */
export interface InteractionPort {
  bind(hold: ApprovalHold): void
  current(): ApprovalHold | undefined
}

/** The current operation's interaction, or undefined outside any bound operation. */
export type InteractionSource = () => Promise<Interaction | undefined>

/** Buckle's first scoped service: one port per operation scope (nitro/runtime.md, Lifetimes). */
export const InteractionService: ScopedDefinition<InteractionPort> = defineScoped<InteractionPort>({
  name: 'Interaction',
  create: () => createInteractionPort(),
})

/** An operation nobody bound: no question is asked and the call reports back at once. */
export const NO_INTERACTION: Interaction = {
  requestCli: async request => ({ status: 'unavailable', requestId: request.id, reason: 'no_consumer' }),
  hold: 'prompt',
}

export const APPROVAL_REQUEST_KIND = 'approval'

/**
 * What the durable owner queue says about a question nobody could take: the ask was issued before it
 * was asked, so it is already waiting, answerable with the command it carries. Never an approval.
 */
export async function approvalPending(request: CliRequest): Promise<PendingInteraction | undefined> {
  const approve = request.action.details?.approve
  if (request.kind !== APPROVAL_REQUEST_KIND || typeof approve !== 'string') return undefined
  return { id: request.id, instructions: approve }
}

function createInteractionPort(): InteractionPort {
  let bound: ApprovalHold | undefined
  return {
    bind(hold) {
      if (bound) throw new Error('This operation already has an interaction bound')
      bound = hold
    },
    current: () => bound,
  }
}
