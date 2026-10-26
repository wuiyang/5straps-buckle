import { renameSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

/** How many times a rename over a file is tried, and the pause before the next try, which grows each time. */
const RENAME_ATTEMPTS = 5
const RENAME_PAUSE_MS = 20

/** The rename and the pause replaceFile uses; a test hands in its own. */
export interface RenameIo {
  rename(from: string, to: string): void
  pause(ms: number): Promise<void>
}

const SYSTEM_RENAME: RenameIo = { rename: renameSync, pause: ms => delay(ms) }

/**
 * Renames a written temporary over a file. On Windows that rename fails with EPERM or EBUSY while another handle
 * holds the file open (a reader in another Buckle process, a virus scanner), so it is tried again a few times, a short
 * pause apart, and the last failure is thrown. Any other failure is thrown at once.
 */
export async function replaceFile(from: string, to: string, io: RenameIo = SYSTEM_RENAME): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      io.rename(from, to)
      return
    } catch (error) {
      if (attempt >= RENAME_ATTEMPTS || !isHeldOpen(error)) throw error
      await io.pause(RENAME_PAUSE_MS * attempt)
    }
  }
}

/** Whether a rename failed because another handle holds a file open, as Windows reports it. */
export function isHeldOpen(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'EPERM' || error.code === 'EBUSY')
}
