import type { Interaction, InteractionSource } from '../../common/services/approvals/interaction.js'
import { NO_INTERACTION } from '../../common/services/approvals/interaction.js'

/** A node entry point with nobody at a terminal: a gated call is held for the grace period. */
export const headlessGrace: Interaction = { requestCli: NO_INTERACTION.requestCli, hold: 'grace' }

/** The same interaction for every call, where a test has no operation scope to bind one to. */
export function fixedInteraction(interaction: Interaction = headlessGrace): InteractionSource {
  return async () => interaction
}
