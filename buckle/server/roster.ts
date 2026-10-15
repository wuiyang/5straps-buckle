import { printable } from '../common/domain/approval-instruction.js'
import { logger } from '../common/runtime/log.js'
import { WorkspaceError, type WorkspaceDescriptor, type WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import type { WorkspaceSettings } from '../common/services/workspaces/workspace-settings.js'

/** How often `buckle serve` looks for a change to the workspaces it lists: a stat-cheap read, never a watcher (Q2). */
export const ROSTER_POLL_MS = 2_000

/**
 * The online workspaces as `buckle serve` lists them, at start and after each change (the workspace-model brief, item
 * 6): each one's name and id, where the agent sees its folder and from where, its URL mode, and the packs it offers. A
 * workspace that will not open is listed with its reason, and the rest are served. The owner's terminal, so paths show.
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
  let settings: WorkspaceSettings
  let waiting: string | null = null
  try {
    const { runtime } = await workspaces.resolve(workspace.id)
    try { await runtime.takeUpSettings() } catch (error) {
      if (!(error instanceof WorkspaceError)) throw error
      waiting = error.message
    }
    packs = runtime.manifest().packs.filter(pack => pack.unavailableReason === null).map(pack => pack.id).join(', ') || 'none'
    settings = workspaces.settings(workspace.id)
  } catch (error) {
    return [head, `    could not open, so it answers each call with the reason: ${error instanceof Error ? error.message : String(error)}`]
  }
  const mount = settings.mounts.find(entry => entry.kind === 'workspace')
  const urls = settings.policy.network.allow.length
  return [
    head,
    `    folder  ${mount ? `${mount.target} from ${workspace.dir}` : `${workspace.dir}, at its real path`}`,
    `    URLs    ${urls === 0 ? 'no approved list' : `an approved list of ${urls} entr${urls === 1 ? 'y' : 'ies'}`}`,
    `    packs   ${packs}`,
    ...(waiting === null ? [] : [`    note    ${waiting}`]),
  ]
}

/**
 * Lists the online workspaces again whenever the registry or a workspace's settings change, read every `intervalMs`
 * on a timer that never holds the process open, and at each look closes what a workspace removed or taken offline left
 * open, its browser, terminals, and language servers among it (finding 2 of the Phase 1 review). Returns what stops it.
 */
export function watchOnline(input: { workspaces: WorkspaceManager; write: (text: string) => void; intervalMs?: number }): () => void {
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
  const timer = setInterval(() => {
    if (running) return
    running = true
    void look().finally(() => { running = false })
  }, input.intervalMs ?? ROSTER_POLL_MS)
  timer.unref()
  return () => clearInterval(timer)
}

/** What the list depends on: the registry, and each online workspace's settings revision, or that they will not read. */
function fingerprint(workspaces: WorkspaceManager): string {
  let listed: WorkspaceDescriptor[]
  try { listed = workspaces.list() } catch (error) { return `unreadable registry: ${error instanceof Error ? error.message : String(error)}` }
  return JSON.stringify(listed.map((workspace) => {
    if (!workspace.online) return [workspace.id, false]
    try { return [workspace.id, workspace.name, workspace.dir, workspaces.settings(workspace.id).revision] } catch { return [workspace.id, 'unreadable settings'] }
  }))
}
