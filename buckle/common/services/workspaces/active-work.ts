import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'pathe'
import { z } from 'zod'
import { holderKey, type GrantHolder } from '../../domain/permission/grant-holder.js'
import { logger } from '../../runtime/log.js'

/** How often a process with calls running in a workspace refreshes its mark. */
export const ACTIVE_WORK_REFRESH_MS = 2_000
/** How long another process takes a mark as running after its last refresh: a process that died stops refreshing. */
export const ACTIVE_WORK_FRESH_MS = 10_000
/** The executing marks' names start with it; every other mark is a process's active work, named by its pid. */
const EXECUTING = 'executing-'
/** An executing mark is written beside itself under this suffix, then renamed, so no reader meets one half written. */
const WRITING = '.tmp'
/** What an executing mark holds: the sessions whose tools run in its runtime. */
const executingSchema = z.object({ sessions: z.array(z.object({ sessionId: z.string(), actor: z.string().optional() })) })

/**
 * Where processes mark the calls they run in one workspace, `<state>/workspaces/<id>/active-work/<pid>`: a call runs in
 * whichever process serves it, and `buckle workspace disable` and `remove` run in another, which sees it only here.
 * One mark per process, so one going idle never clears another's. The executing marks
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

/**
 * One tool's run, from its start to its end, whatever becomes of its result, or one call's hold for a person's answer, from
 * the start of its wait to its end.
 */
export interface ExecutingRun {
  end(): void
}

/**
 * A runtime's executing mark: held on disk while any of its tools runs or any of its calls is held for a person's answer
 * (APPROVAL-31), and naming those sessions, so each session's idle check reads its own. Named by the runtime's own instance
 * id, not its pid, so a new process under a dead one's pid never refreshes its mark.
 */
export interface ExecutingMark {
  begin(session: GrantHolder): ExecutingRun
  /**
   * Whether a tool of the session runs, or a call of it is held for an answer, in this runtime now, which its idle check
   * counts as activity without reading the marks.
   */
  running(session: GrantHolder): boolean
}

/** One runtime's executing mark as another process reads it. */
export interface ExecutingMarkReading { instance: string; sessions: GrantHolder[] }

export function createExecutingMark(input: { directory: string; workspaceId: string; instance: string }): ExecutingMark {
  // The sessions whose tools run or whose calls are held, each with how many of its runs and holds hold the mark.
  const holding = new Map<string, { session: GrantHolder; runs: number }>()
  const content = () => JSON.stringify({ sessions: [...holding.values()].map(held => held.session) })
  const lease = markLease({ directory: input.directory, file: join(input.directory, `${EXECUTING}${input.instance}`), workspaceId: input.workspaceId, content })
  // Never thrown: a tool that cleared runs, and answers as it ran. A missing mark can only end sessions early, which asks again.
  const guarded = (step: () => void) => {
    try { step() } catch (error) {
      logger.warn('Could not mark that a tool runs in this workspace; another process may take it as idle meanwhile', { workspaceId: input.workspaceId, error })
    }
  }
  const hold = (session: GrantHolder) => {
    const key = holderKey(session)
    const held = holding.get(key)
    if (held !== undefined) { held.runs++; return }
    const first = holding.size === 0
    holding.set(key, { session, runs: 1 })
    guarded(first ? lease.start : lease.write)
  }
  const release = (session: GrantHolder) => {
    const key = holderKey(session)
    const held = holding.get(key)
    if (held === undefined || --held.runs > 0) return
    holding.delete(key)
    guarded(holding.size === 0 ? lease.stop : lease.write)
  }
  return {
    running: session => holding.has(holderKey(session)),
    begin(session) {
      let ended = false
      hold(session)
      return {
        end() {
          if (ended) return
          ended = true
          release(session)
        },
      }
    },
  }
}

/**
 * The instances running a tool in the workspace now, each with the sessions whose tools it runs, each mark refreshed within
 * ACTIVE_WORK_FRESH_MS. A stale mark, which a process that died left, is removed, as is one it left half written. Throws
 * where the marks cannot be read, a fresh one included, which the idle check takes as activity unknown.
 */
export function executingMarks(input: { directory: string; now?: number }): ExecutingMarkReading[] {
  const now = input.now ?? Date.now()
  return markNames(input.directory).filter(mark => mark.startsWith(EXECUTING)).flatMap((mark) => {
    const file = join(input.directory, mark)
    if (!markIsFresh(file, now)) {
      rmSync(file, { force: true })
      return []
    }
    if (mark.endsWith(WRITING)) return []
    const sessions = readMark(file)
    return sessions === undefined || sessions.length === 0 ? [] : [{ instance: mark.slice(EXECUTING.length), sessions }]
  })
}

/** The sessions a mark names; undefined where it went since the listing, as a process gone idle. */
function readMark(file: string): GrantHolder[] | undefined {
  let text: string
  try { text = readFileSync(file, 'utf8') } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  return executingSchema.parse(JSON.parse(text)).sessions.map(({ sessionId, actor }) => actor === undefined ? { sessionId } : { sessionId, actor })
}

interface MarkLease extends ActiveWorkMark {
  /** Writes the mark again with what it holds now. */
  write(): void
}

function markLease(input: { directory: string; file: string; workspaceId: string; content?: () => string }): MarkLease {
  let timer: NodeJS.Timeout | undefined
  // Said once until a refresh lands again, not every ACTIVE_WORK_REFRESH_MS.
  let failing = false
  const write = () => {
    if (input.content === undefined) return writeFileSync(input.file, '', { mode: 0o600 })
    const writing = `${input.file}${WRITING}`
    writeFileSync(writing, input.content(), { mode: 0o600 })
    renameSync(writing, input.file)
  }
  const touch = () => {
    try { utimesSync(input.file, new Date(), new Date()) } catch (error) {
      // Written again where a reader removed it as stale while this process stalled, or where the first write failed.
      if (!isMissing(error)) throw error
      write()
    }
  }
  const refresh = () => {
    try {
      touch()
      failing = false
    } catch (error) {
      if (!failing) logger.warn('Could not refresh the mark another process reads for this workspace\'s running calls', { workspaceId: input.workspaceId, error })
      failing = true
    }
  }
  return {
    start() {
      // Set before the first write, so one that fails is written at a later refresh while the work lasts.
      timer = setInterval(refresh, ACTIVE_WORK_REFRESH_MS)
      timer.unref()
      mkdirSync(input.directory, { recursive: true, mode: 0o700 })
      write()
    },
    stop() {
      clearInterval(timer)
      timer = undefined
      rmSync(input.file, { force: true })
    },
    write,
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
