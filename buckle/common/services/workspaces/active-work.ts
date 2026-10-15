import { mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'pathe'
import { logger } from '../../runtime/log.js'

/** How often a process with calls running in a workspace refreshes its mark. */
export const ACTIVE_WORK_REFRESH_MS = 2_000
/** How long another process takes a mark as running after its last refresh: a process that died stops refreshing. */
export const ACTIVE_WORK_FRESH_MS = 10_000

/**
 * Where processes mark the calls they run in one workspace, `<state>/workspaces/<id>/active-work/<pid>`: a call runs in
 * whichever process serves it, and `buckle workspace disable` and `remove` run in another, which sees it only here
 * (finding 9 of the Phase 1 review). One mark per process, so one going idle never clears another's.
 */
export function activeWorkDirectory(nodeStateDirectory: string, workspaceId: string): string {
  return join(nodeStateDirectory, 'workspaces', workspaceId, 'active-work')
}

export interface ActiveWorkMark {
  /** The first call started: the mark is written, and refreshed while calls run. */
  start(): void
  /** The last call ended, or the process closes the workspace: the mark goes. */
  stop(): void
}

export function createActiveWorkMark(input: { directory: string; workspaceId: string; pid?: number }): ActiveWorkMark {
  const file = join(input.directory, String(input.pid ?? process.pid))
  let timer: NodeJS.Timeout | undefined
  const refresh = () => {
    try { utimesSync(file, new Date(), new Date()) } catch (error) {
      logger.warn('Could not refresh the mark another process reads for this workspace\'s running calls', { workspaceId: input.workspaceId, error })
    }
  }
  return {
    start() {
      mkdirSync(input.directory, { recursive: true, mode: 0o700 })
      writeFileSync(file, '', { mode: 0o600 })
      timer = setInterval(refresh, ACTIVE_WORK_REFRESH_MS)
      timer.unref()
    },
    stop() {
      clearInterval(timer)
      timer = undefined
      rmSync(file, { force: true })
    },
  }
}

/** Whether a process other than this one marks calls running in the workspace, refreshed within ACTIVE_WORK_FRESH_MS. */
export function activeElsewhere(input: { directory: string; pid?: number; now?: number }): boolean {
  let marks: string[]
  try { marks = readdirSync(input.directory) } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
  const own = String(input.pid ?? process.pid)
  const now = input.now ?? Date.now()
  return marks.some((mark) => {
    if (mark === own) return false
    // A mark removed since the listing is a process gone idle.
    try { return now - statSync(join(input.directory, mark)).mtimeMs < ACTIVE_WORK_FRESH_MS } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
      throw error
    }
  })
}
