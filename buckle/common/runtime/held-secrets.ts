import type { Masker } from '../domain/secret-mask.js'

/**
 * The values of every call that holds some now, so a log line any part of Buckle writes meanwhile is masked as the
 * call's own result is (docs/user/how-to/secrets.md). A call holds its masker from the moment it reads its values until it has
 * answered.
 */
const held = new Set<Masker>()

export function holdMasker(masker: Masker): () => void {
  held.add(masker)
  return () => { held.delete(masker) }
}

/** Whether any call holds values now; nothing is walked while none does. */
export function masksHeld(): boolean {
  return held.size > 0
}

/** Text with every value any call holds now masked. */
export function maskHeld(text: string): string {
  let masked = text
  for (const masker of held) masked = masker.text(masked)
  return masked
}

/** A value with every string in it masked by every value any call holds now. */
export function maskHeldJson<T>(value: T): T {
  let masked = value
  for (const masker of held) masked = masker.json(masked)
  return masked
}
