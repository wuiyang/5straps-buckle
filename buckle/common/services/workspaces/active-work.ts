import { mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'pathe'
import { logger } from '../../runtime/log.js'

/** How often a process with calls running in a workspace refreshes its mark. */
export const ACTIVE_WORK_REFRESH_MS = 2_000
/** How long another process takes a mark as running after its last refresh: a process that died stops refreshing. */
export const ACTIVE_WORK_FRESH_MS = 10_000
/** The executing marks' names start with it; every other mark is a process's active work, named by its pid. */
const EXECUTING = 'executing-'

/**
 * Where processes mark the calls they run in one workspace, `<state>/workspaces/<id>/active-work/<pid>`: a call runs in
 * whichever process serves it, and `buckle workspace disable` and `remove` run in another, which sees it only here
 * (finding 9 of the Phase 1 review). One mark per process, so one going idle never clears another's. The executing marks
 * live beside them, `executing-<instance>`.
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
  return markLease({ directory: input.directory, file: join(input.directory, String(input.pid ?? process.pid)), workspaceId: input.workspaceId })
}

/** Whether a process other than this one marks calls running in the workspace, refreshed within ACTIVE_WORK_FRESH_MS. */
export function activeElsewhere(input: { directory: string; pid?: number; now?: number }): boolean {
  const own = String(input.pid ?? process.pid)
  const now = input.now ?? Date.now()
  return markNames(input.directory).some(mark => !mark.startsWith(EXECUTING) && mark !== own && markIsFresh(join(input.directory, mark), now))
}

/** One tool's run, from its start to its end, whatever becomes of its result. */
export interface ExecutingRun {
  /** While a call of the run's script waits for a person, the run does not hold the workspace. */
  paused<T>(wait: () => Promise<T>): Promise<T>
  end(): void
}

/**
 * A runtime's executing mark: held on disk while any of its tools runs, never while a call only waits for an answer.
 * Named by the runtime's own instance id, not its pid, so a new process under a dead one's pid never refreshes its mark.
 */
export interface ExecutingMark {
  begin(): ExecutingRun
  /** Whether a tool of this runtime runs now, which its own idle check counts as activity without reading the marks. */
  running(): boolean
}

export function createExecutingMark(input: { directory: string; workspaceId: string; instance: string }): ExecutingMark {
  const lease = markLease({ directory: input.directory, file: join(input.directory, `${EXECUTING}${input.instance}`), workspaceId: input.workspaceId })
  // Never thrown: a tool that cleared runs, and answers as it ran. A missing mark can only end sessions early, which asks again.
  const guarded = (step: () => void) => {
    try { step() } catch (error) {
      logger.warn('Could not mark that a tool runs in this workspace; another process may take it as idle meanwhile', { workspaceId: input.workspaceId, error })
    }
  }
  let holding = 0
  const hold = () => { if (holding++ === 0) guarded(lease.start) }
  const release = () => { if (--holding === 0) guarded(lease.stop) }
  return {
    running: () => holding > 0,
    begin() {
      let pauses = 0
      let ended = false
      const holds = () => !ended && pauses === 0
      hold()
      return {
        async paused(wait) {
          if (holds()) release()
          pauses++
          try { return await wait() } finally {
            pauses--
            if (holds()) hold()
          }
        },
        end() {
          if (ended) return
          const held = holds()
          ended = true
          if (held) release()
        },
      }
    },
  }
}

/**
 * The instances running a tool in the workspace now, each mark refreshed within ACTIVE_WORK_FRESH_MS. A stale mark, which a
 * process that died left, is removed. Throws where the marks cannot be read, which the idle check takes as activity unknown.
 */
export function executingInstances(input: { directory: string; now?: number }): string[] {
  const now = input.now ?? Date.now()
  return markNames(input.directory).filter(mark => mark.startsWith(EXECUTING)).flatMap((mark) => {
    const file = join(input.directory, mark)
    if (markIsFresh(file, now)) return [mark.slice(EXECUTING.length)]
    rmSync(file, { force: true })
    return []
  })
}

function markLease(input: { directory: string; file: string; workspaceId: string }): ActiveWorkMark {
  let timer: NodeJS.Timeout | undefined
  const write = () => writeFileSync(input.file, '', { mode: 0o600 })
  const touch = () => {
    try { utimesSync(input.file, new Date(), new Date()) } catch (error) {
      // Written again where a reader removed it as stale while this process stalled.
      if (!isMissing(error)) throw error
      write()
    }
  }
  const refresh = () => {
    try { touch() } catch (error) {
      logger.warn('Could not refresh the mark another process reads for this workspace\'s running calls', { workspaceId: input.workspaceId, error })
    }
  }
  return {
    start() {
      mkdirSync(input.directory, { recursive: true, mode: 0o700 })
      write()
      timer = setInterval(refresh, ACTIVE_WORK_REFRESH_MS)
      timer.unref()
    },
    stop() {
      clearInterval(timer)
      timer = undefined
      rmSync(input.file, { force: true })
    },
  }
}

function markNames(directory: string): string[] {
  try { return readdirSync(directory) } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}

function markIsFresh(file: string, now: number): boolean {
  // A mark removed since the listing is a process gone idle.
  try { return now - statSync(file).mtimeMs < ACTIVE_WORK_FRESH_MS } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
