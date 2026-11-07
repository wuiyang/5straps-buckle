import { createMemoryNonceClaims } from '../../common/adapters/approval/memory-nonce-claims.js'
import { createTerminalBackend } from '../../common/adapters/approval/terminal-backend.js'
import { createApprovalService, type ApprovalService, type ApprovalServiceOptions } from '../../common/services/approvals/approval-service.js'
import type { Interaction, InteractionSource } from '../../common/runtime/interaction.js'
import { NO_INTERACTION } from '../../common/runtime/interaction.js'

/** A node entry point with nobody at a terminal: a gated call is held for the grace period. */
export const headlessGrace: Interaction = { requestCli: NO_INTERACTION.requestCli, hold: 'grace' }

/** The same interaction for every call, where a test has no operation scope to bind one to. */
export function fixedInteraction(interaction: Interaction = headlessGrace): InteractionSource {
  return async () => interaction
}

/** The approval service as a node composes it: its terminal asks over the interaction's requester. */
export function approvalServiceWithTerminal(input: Omit<ApprovalServiceOptions, 'terminal' | 'nonces' | 'hold'> & { interaction: InteractionSource }): ApprovalService {
  const { interaction, ...options } = input
  return createApprovalService({ ...options, hold: async () => (await interaction())?.hold, nonces: createMemoryNonceClaims(), terminal: createTerminalBackend({ requester: async () => (await interaction())?.requestCli }) })
}
