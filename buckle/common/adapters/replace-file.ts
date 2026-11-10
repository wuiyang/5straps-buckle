import { renameSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { isHeldOpen } from '../domain/filesystem-errors.js'
import { HELD_FILE_ATTEMPTS, HELD_FILE_PAUSE_MS } from './filesystem-retry.js'

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
      if (attempt >= HELD_FILE_ATTEMPTS || !isHeldOpen(error)) throw error
      await io.pause(HELD_FILE_PAUSE_MS * attempt)
    }
  }
}
