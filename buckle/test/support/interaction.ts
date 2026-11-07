import { createTerminalBackend } from '../../common/adapters/approval/terminal-backend.js'
import { createApprovalService, type ApprovalService, type ApprovalServiceOptions } from '../../common/services/approvals/approval-service.js'
import type { Interaction, InteractionSource } from '../../common/services/approvals/interaction.js'
import { NO_INTERACTION } from '../../common/services/approvals/interaction.js'

/** A node entry point with nobody at a terminal: a gated call is held for the grace period. */
export const headlessGrace: Interaction = { requestCli: NO_INTERACTION.requestCli, hold: 'grace' }

/** The same interaction for every call, where a test has no operation scope to bind one to. */
export function fixedInteraction(interaction: Interaction = headlessGrace): InteractionSource {
  return async () => interaction
}

/** The approval service as a node composes it: its terminal asks over the interaction's requester. */
export function approvalServiceWithTerminal(options: Omit<ApprovalServiceOptions, 'terminal'>): ApprovalService {
  return createApprovalService({ ...options, terminal: createTerminalBackend({ requester: async () => (await options.interaction())?.requestCli }) })
}
