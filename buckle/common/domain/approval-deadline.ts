import { APPROVAL_NO_DEADLINE } from '@5straps/protocol'
import { remainingMs } from './approval/expiry.js'
import { localDate, localTime } from './local-time.js'

/**
 * An approval has two deadlines, and they are not the same one:
 *
 * - The **request expiry**, ten minutes beyond the configured finite wait, after which the token resolves no
 *   longer: `buckle approve` on it answers "unknown or expired".
 * - The **grace period**, fifteen seconds by default, which is only how long one gated call is
 *   held open while it waits for an answer. A call that gives up leaves the request answerable.
 *
 * Forever waits use the protocol no-deadline marker; cancellation drops the pending token.
 *
 * Everything a person is shown about the first is worded here, so the two never read as one.
 */

/** `expires in 9m 58s (2026-09-22T07:41:02.000Z)`, the request expiry in both readings. */
export function describeExpiry(expiresAt: string): string {
  if (expiresAt === APPROVAL_NO_DEADLINE) return 'no expiry; waiting for an owner decision'
  const remaining = remainingMs(expiresAt)
  if (remaining === 0) return `expired (${expiresAt})`
  return `expires in ${describeDuration(remaining)} (${expiresAt})`
}

/**
 * The serve terminal's reading of the request expiry (the CLI display slice, C4): `expires in 9m 58s (at 22:32:00)`, on
 * this device's clock, with the date where it is not today's. Every other route, the relayed text and a person's
 * device among them, keeps describeExpiry's ISO UTC.
 */
export function describeLocalExpiry(expiresAt: string): string {
  const at = new Date(expiresAt)
  if (expiresAt === APPROVAL_NO_DEADLINE || Number.isNaN(at.getTime())) return describeExpiry(expiresAt)
  const clock = `at ${localDate(at) === localDate(new Date()) ? '' : `${localDate(at)} `}${localTime(at)}`
  const remaining = remainingMs(expiresAt)
  return remaining === 0 ? `expired (${clock})` : `expires in ${describeDuration(remaining)} (${clock})`
}

function describeDuration(ms: number): string {
  const seconds = Math.ceil(ms / 1_000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
