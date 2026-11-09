import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'pathe'
import { z } from 'zod'
import { holderKey, type GrantHolder } from '../../domain/permission/grant-holder.js'
import { logger } from '../../runtime/log.js'

/** How often a process with calls running in a workspace refreshes its mark. */
export const ACTIVE_WORK_REFRESH_MS = 2_000
/** How long another process takes a mark as running after its last refresh: a process that died stops refreshing. */
export const ACTIVE_WORK_FRESH_MS = 10_000
/**
 * How long a stale executing mark whose writer's pid still answers counts as a stall, as on sync disk work under heavy I/O,
 * rather than a dead process. Past it the mark is taken as dead whatever its pid: no stall lasts that long, and a pid the
 * system gave a new process since answers as well, while that process never refreshes a mark named by another runtime.
 */
export const ACTIVE_WORK_STALLED_MS = 300_000
/** The executing marks' names start with it; every other mark is a process's active work, named by its pid. */
const EXECUTING = 'executing-'
/** An executing mark is written beside itself under this suffix, then renamed, so no reader meets one half written. */
const WRITING = '.tmp'
/**
 * What an executing mark holds: the sessions whose tools run in its runtime or whose calls it holds for an answer, the asks
 * those calls hold (heldAskName), and the pid of the process that wrote it. A mark written before the asks and the pid were
 * kept names neither.
 */
const executingSchema = z.object({
  sessions: z.array(z.object({ sessionId: z.string(), actor: z.string().optional() })),
  asks: z.array(z.string()).optional(),
  pid: z.number().int().positive().optional(),
})
type MarkContent = z.infer<typeof executingSchema>

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
 * before its ask is recorded to the end of its wait.
 */
export interface ExecutingRun {
  end(): void
}

/**
 * A runtime's executing mark: held on disk while any of its tools runs or any of its calls is held for a person's answer,
 * naming those sessions, so each session's idle check reads its own, and the asks held, so another process starts no
 * held ask's lapse. Named by the runtime's own instance id, not its pid, so a new process under a dead one's pid never
 * refreshes its mark.
 */
export interface ExecutingMark {
  /** `ask`: the ask a call holds for a person's answer, by heldAskName. */
  begin(session: GrantHolder, ask?: string): ExecutingRun
  /**
   * Whether a tool of the session runs, or a call of it is held for an answer, in this runtime now, which its idle check
   * counts as activity without reading the marks.
   */
  running(session: GrantHolder): boolean
}

/**
 * One runtime's executing mark as another process reads it. `stalled`: the mark went stale while the process that wrote it
 * still runs, which says nothing either way of its sessions.
 */
export interface ExecutingMarkReading { instance: string; sessions: GrantHolder[]; asks: string[]; stalled?: true }

/** The sessions the marks name: those a fresh mark names, whose tools run or calls are held now, and those a stalled one names. */
export interface ExecutingSessions { running: GrantHolder[]; stalled: GrantHolder[] }

export function createExecutingMark(input: { directory: string; workspaceId: string; instance: string }): ExecutingMark {
  // The sessions whose tools run or whose calls are held, each with how many of its runs and holds hold the mark, and the
  // asks held, each with how many holds hold it.
  const holding = new Map<string, { session: GrantHolder; runs: number }>()
  const asks = new Map<string, number>()
  const content = () => JSON.stringify({ pid: process.pid, sessions: [...holding.values()].map(held => held.session), asks: [...asks.keys()] })
  const lease = markLease({ directory: input.directory, file: join(input.directory, `${EXECUTING}${input.instance}`), workspaceId: input.workspaceId, content })
  // Never thrown: a tool that cleared runs, and answers as it ran. A missing mark can only end sessions early, which asks again.
  const guarded = (step: () => void) => {
    try { step() } catch (error) {
      logger.warn('Could not mark that a tool runs in this workspace; another process may take it as idle meanwhile', { workspaceId: input.workspaceId, error })
    }
  }
  const hold = (session: GrantHolder, ask: string | undefined) => {
    const key = holderKey(session)
    const first = holding.size === 0
    const held = holding.get(key)
    let changed = held === undefined
    if (held === undefined) holding.set(key, { session, runs: 1 })
    else held.runs++
    if (ask !== undefined) {
      const count = asks.get(ask) ?? 0
      asks.set(ask, count + 1)
      if (count === 0) changed = true
    }
    if (changed) guarded(first ? lease.start : lease.write)
  }
  const release = (session: GrantHolder, ask: string | undefined) => {
    const key = holderKey(session)
    const held = holding.get(key)
    if (held === undefined) return
    let changed = --held.runs === 0
    if (changed) holding.delete(key)
    const count = ask === undefined ? 0 : asks.get(ask) ?? 0
    if (count > 1) asks.set(ask!, count - 1)
    else if (count === 1) {
      asks.delete(ask!)
      changed = true
    }
    if (changed) guarded(holding.size === 0 ? lease.stop : lease.write)
  }
  return {
    running: session => holding.has(holderKey(session)),
    begin(session, ask) {
      let ended = false
      hold(session, ask)
      return {
        end() {
          if (ended) return
          ended = true
          release(session, ask)
        },
      }
    },
  }
}

/**
 * The instances running a tool or holding a call in the workspace now, each with its sessions and the asks it holds: each
 * mark refreshed within ACTIVE_WORK_FRESH_MS, and each stale one whose writer still runs, read as stalled for up to
 * ACTIVE_WORK_STALLED_MS. Any other stale mark, which a process that died left, is removed, as is one it left half
 * written. Throws where the marks cannot be read, a fresh one included, which the idle check takes as activity unknown.
 */
export function executingMarks(input: { directory: string; now?: number }): ExecutingMarkReading[] {
  const now = input.now ?? Date.now()
  return markNames(input.directory).filter(mark => mark.startsWith(EXECUTING)).flatMap((mark) => {
    const file = join(input.directory, mark)
    const age = markAge(file, now)
    // Removed since the listing: a process gone idle.
    if (age === undefined) return []
    const fresh = age < ACTIVE_WORK_FRESH_MS
    if (mark.endsWith(WRITING)) {
      if (!fresh) rmSync(file, { force: true })
      return []
    }
    const read = fresh ? readMark(file) : stalledMark(file, age)
    if (read === undefined) {
      if (!fresh) rmSync(file, { force: true })
      return []
    }
    if (read.sessions.length === 0) return []
    const sessions = read.sessions.map(({ sessionId, actor }) => actor === undefined ? { sessionId } : { sessionId, actor })
    return [{ instance: mark.slice(EXECUTING.length), sessions, asks: read.asks ?? [], ...(fresh ? {} : { stalled: true as const }) }]
  })
}

/** The sessions the executing marks name, apart by whether their mark is fresh or stalled; throws as executingMarks does. */
export function executingSessions(input: { directory: string; now?: number }): ExecutingSessions {
  const marks = executingMarks(input)
  return { running: marks.filter(mark => !mark.stalled).flatMap(mark => mark.sessions), stalled: marks.filter(mark => mark.stalled).flatMap(mark => mark.sessions) }
}

/**
 * The asks a call in a runtime other than `instance` holds for a person's answer, by heldAskName, a stalled runtime's
 * included, since its call may still be held; throws as executingMarks does.
 */
export function asksHeldElsewhere(input: { directory: string; instance: string; now?: number }): Set<string> {
  return new Set(executingMarks(input).filter(mark => mark.instance !== input.instance).flatMap(mark => mark.asks))
}

/** What a mark holds; undefined where it went since the listing, as a process gone idle. */
function readMark(file: string): MarkContent | undefined {
  let text: string
  try { text = readFileSync(file, 'utf8') } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  return executingSchema.parse(JSON.parse(text))
}

/**
 * What a stale mark holds where the process that wrote it still runs and it went stale less than ACTIVE_WORK_STALLED_MS
 * ago; undefined where it is dead: no pid, a pid that answers to nothing, or one that cannot be read or parsed.
 */
function stalledMark(file: string, age: number): MarkContent | undefined {
  if (age >= ACTIVE_WORK_STALLED_MS) return undefined
  let read: MarkContent | undefined
  try { read = readMark(file) } catch { return undefined }
  return read?.pid !== undefined && processRuns(read.pid) ? read : undefined
}

/** Whether a process runs under the pid: one another user runs answers EPERM, which still runs. */
function processRuns(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

interface MarkLease extends ActiveWorkMark {
  /** Writes the mark again with what it holds now. */
  write(): void
}

function markLease(input: { directory: string; file: string; workspaceId: string; content?: () => string }): MarkLease {
  let timer: NodeJS.Timeout | undefined
  // Said once until a refresh lands again, not every ACTIVE_WORK_REFRESH_MS.
  let failing = false
  // What the mark holds on disk, as its last write that landed left it.
  let landed: string | undefined
  const contentNow = () => input.content?.() ?? ''
  const write = () => {
    const text = contentNow()
    if (input.content === undefined) writeFileSync(input.file, text, { mode: 0o600 })
    else {
      const writing = `${input.file}${WRITING}`
      writeFileSync(writing, text, { mode: 0o600 })
      renameSync(writing, input.file)
    }
    landed = text
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
      // Written whole where it may not hold what it should, as after a write that failed; touched otherwise.
      if (landed !== contentNow()) write()
      else touch()
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
      landed = undefined
      mkdirSync(input.directory, { recursive: true, mode: 0o700 })
      write()
    },
    stop() {
      clearInterval(timer)
      timer = undefined
      landed = undefined
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
  const age = markAge(file, now)
  return age !== undefined && age < ACTIVE_WORK_FRESH_MS
}

/** How long ago the mark was last written or refreshed; undefined where it was removed since the listing. */
function markAge(file: string, now: number): number | undefined {
  try { return now - statSync(file).mtimeMs } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
