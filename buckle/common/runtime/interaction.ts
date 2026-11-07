import { defineScoped, type RequestCli, type ScopedDefinition } from '@5straps/runtime'
import type { ApprovalHold } from '../types/ports/approval-backend.js'

/**
 * How an operation reaches a person: the process's requester, which the terminal backend asks over, and the hold its
 * transport chose, which the approval service holds a call to.
 *
 * Only the hold is scoped. The requester is process-level, bound once by main on the common runtime,
 * because the approval service is a per-workspace singleton that keeps asking after a `grace` call
 * returns, and a singleton must not retain a scoped value (nitro/runtime.md, Lifetimes).
 */
export interface Interaction {
  readonly requestCli: RequestCli
  readonly hold: ApprovalHold
}

/** Bound once per operation scope by the transport that opened it. */
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
