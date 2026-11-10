import { watch, type FSWatcher } from 'node:fs'
import { printable } from '../common/domain/approval-instruction.js'
import { localTime } from '../common/domain/local-time.js'
import type { ConsoleWriter } from '../common/runtime/console.js'
import { logger } from '../common/runtime/log.js'
import { type WorkspaceDescriptor, type WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import { WorkspaceError } from '../common/domain/workspace-error.js'
import type { WorkspacePolicy } from '@5straps/protocol'
import type { ViewMount } from '../common/domain/path-view.js'

/** How often `buckle serve` looks for a change to the workspaces it lists: a stat-cheap read, never a watcher (Q2). */
export const ROSTER_POLL_MS = 2_000

/**
 * The online workspaces as `buckle serve` lists them, at start and after each change (the workspace-model brief, item
 * 6): each one's name and id, where the agent sees its folder and from where, its URL mode, and the packs it offers. A
 * workspace that will not open is listed with its reason, and the rest are served. The owner's terminal, so paths show,
 * escaped as the name is (the CLI display slice, C3): a folder's name or an error's text can carry what a terminal acts on.
 */
export async function describeOnline(workspaces: WorkspaceManager): Promise<string> {
  const online = workspaces.list().filter(workspace => workspace.online)
  if (online.length === 0) return 'No workspace is online: buckle workspace init serves a folder, and buckle workspace enable <id> serves one again.\n'
  const lines = [`Serving ${online.length} workspace${online.length === 1 ? '' : 's'}:`]
  for (const workspace of online) lines.push(...await describeWorkspace(workspaces, workspace))
  return `${lines.join('\n')}\n`
}

async function describeWorkspace(workspaces: WorkspaceManager, workspace: WorkspaceDescriptor): Promise<string[]> {
  const head = `  ${printable(workspace.name)}\n    id      ${workspace.id}`
  let packs: string
  // In force: its own settings, else the node's (D85, Q3).
  let effective: WorkspacePolicy
  let mounts: readonly ViewMount[]
  let waiting: string | null = null
  try {
    const { runtime } = await workspaces.resolve(workspace.id)
    try { await runtime.takeUpSettings() } catch (error) {
      if (!(error instanceof WorkspaceError)) throw error
      waiting = error.message
    }
    packs = runtime.manifest().packs.filter(pack => pack.unavailableReason === null).map(pack => pack.id).join(', ') || 'none'
    effective = runtime.policy.effective()
    mounts = runtime.paths().mounts
  } catch (error) {
    return [head, `    could not open, so it answers each call with the reason: ${printable(error instanceof Error ? error.message : String(error))}`]
  }
  const urls = effective.network.allow.length
  return [
    head,
    `    folder  ${effective.mount ? `${printable(effective.mount)} from ${printable(workspace.dir)}` : `${printable(workspace.dir)}, at its real path`}`,
    // Every mount the agent's view reaches (Phase 2 item 1); the system folders every sandbox binds are never listed (Q1).
    ...mounts.map(mount => `    mount   ${mount.scratch ? `${printable(mount.source)}, a scratch root` : `${printable(mount.target)} from ${printable(mount.source)}`}, ${mount.access === 'rw' ? 'read-write' : 'read-only'}`),
    `    URLs    ${urls === 0 ? 'no approved list' : `an approved list of ${urls} entr${urls === 1 ? 'y' : 'ies'}`}`,
    `    packs   ${packs}`,
    ...(waiting === null ? [] : [`    note    ${printable(waiting)}`]),
  ]
}

/** The list on a person's console (C3): its first line stamped with the time and an `[info]` tag, the rest as listed. */
export function rosterLines(text: string, at: Date): string[] {
  const [first = '', ...rest] = text.trimEnd().split('\n')
  return [`${localTime(at)} [info] ${first}`, ...rest]
}

/** Writes each list through the console writer, in turn after the log lines logged before it. */
export function consoleRoster(writer: ConsoleWriter): (text: string) => void {
  return (text) => {
    const at = new Date()
    void writer.block(rosterLines(text, at), at)
  }
}

/**
 * Lists the online workspaces again whenever the registry or a workspace's settings change, read every `intervalMs`
 * on a timer that never holds the process open, and at each look closes what a workspace removed or taken offline left
 * open, its browser, terminals, and language servers among it (finding 2 of the Phase 1 review). Returns what stops it.
 */
export function watchOnline(input: { workspaces: WorkspaceManager; write: (text: string) => void; intervalMs?: number; watchPath?: string }): () => void {
  let last = fingerprint(input.workspaces)
  let running = false
  const look = async () => {
    await input.workspaces.closeUnserved().catch((error: unknown) => { logger.error('Could not close a workspace this node no longer serves', { error }) })
    const now = fingerprint(input.workspaces)
    if (now === last) return
    last = now
    await describeOnline(input.workspaces)
      .then(text => input.write(`Workspaces changed.\n${text}`))
      .catch((error: unknown) => { logger.error('Could not list the online workspaces after a change', { error }) })
  }
  const run = () => {
    if (running) return
    running = true
    void look().finally(() => { running = false })
  }
  const timer = setInterval(run, input.intervalMs ?? ROSTER_POLL_MS)
  timer.unref()
  // Q2 (Phase 1b item 3): a watcher on the registry folder re-lists at once when workspaces.json changes; the poll
  // stays as the fallback, and catches each workspace's own settings too. A watcher that cannot start is logged once.
  let watcher: FSWatcher | undefined
  let pending: ReturnType<typeof setTimeout> | undefined
  if (input.watchPath !== undefined) {
    try {
      watcher = watch(input.watchPath, { persistent: false }, () => {
        if (pending) return
        pending = setTimeout(() => { pending = undefined; run() }, ROSTER_WATCH_DEBOUNCE_MS)
        pending.unref?.()
      })
      watcher.on('error', (error: unknown) => logger.warn('The workspace registry watcher stopped; the poll carries on', { error }))
    } catch (error) {
      logger.warn('The workspace registry watcher could not start; the poll carries on', { error })
    }
  }
  return () => { clearInterval(timer); if (pending) clearTimeout(pending); watcher?.close() }
}

/** The registry watcher's debounce (Q2): a change is re-listed this long after the last write, within the 100 to 250 ms the brief allows. */
export const ROSTER_WATCH_DEBOUNCE_MS = 150

/** What the list depends on: the registry, and each online workspace's settings revision, or that they will not read. */
function fingerprint(workspaces: WorkspaceManager): string {
  let listed: WorkspaceDescriptor[]
  try { listed = workspaces.list() } catch (error) { return `unreadable registry: ${error instanceof Error ? error.message : String(error)}` }
  return JSON.stringify(listed.map((workspace) => {
    if (!workspace.online) return [workspace.id, false]
    try { return [workspace.id, workspace.name, workspace.dir, workspaces.settings(workspace.id).revision] } catch { return [workspace.id, 'unreadable settings'] }
  }))
}
