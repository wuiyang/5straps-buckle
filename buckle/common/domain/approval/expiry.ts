import { APPROVAL_NO_DEADLINE } from '@5straps/protocol'

/** The longest delay a Node timer takes. */
export const MAX_TIMER_MS = 2_147_483_647

/** How long an ask stays answerable: Infinity for the protocol's no-deadline mark, 0 once passed or unparseable, as the registry refuses such a token. */
export function remainingMs(expiresAt: string): number {
  if (expiresAt === APPROVAL_NO_DEADLINE) return Infinity
  const at = Date.parse(expiresAt)
  if (Number.isNaN(at)) return 0
  return Math.max(at - Date.now(), 0)
}
