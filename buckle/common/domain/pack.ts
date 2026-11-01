import type { PackDescriptor } from '@5straps/protocol'
import type { FilledSecrets, RegisteredTool } from './tool.js'
import type { LoadedSkill } from './skill.js'

export interface Pack {
  id: string
  version: string
  tools: RegisteredTool[]
  skills: LoadedSkill[]
  /** Set when the pack loaded but cannot run here, so operators see why its tools are absent. */
  unavailableReason: string | null
  /** Ends what the pack keeps running between calls (language servers, browser sessions), at shutdown. */
  close?(): void | Promise<void>
  /**
   * Ends what the pack keeps running when a pack rebuilt from other settings takes its place, keeping what the successor
   * carries on: a browser session's key and the list it last ran under, so the session's next call says the browser was
   * relaunched (fix brief 2, R2). `close` when absent.
   */
  retire?(): void | Promise<void>
  /** The fs pack's alone: what runs fs_search_content here, ripgrep or Buckle's own walker, named in the manifest's limits. */
  searcher?: 'rg' | 'builtin'
  /** The browser pack's alone: the values its browsers hold from secret references, which each browser call is masked by. */
  filled?: FilledSecrets
  /**
   * The browser pack's alone, for the owner's buckle browser close (Slice F4, item 6): closes every browser the
   * workspace recorded, in any Buckle process, and forgets every record and every hold.
   */
  closeBrowsers?(): Promise<BrowserCloseCounts>
}

/**
 * What buckle browser close ended: the browsers recorded, how many of them closed, and the held values dropped; and, where
 * it could not end everything, the values still held by a browser that did not close (Codex review L1).
 */
export interface BrowserCloseCounts {
  browsers: number
  closed: number
  held: number
  /** Values still held, by a browser that did not close or an attached Chrome not found closed; absent where none is. */
  kept?: number
  /** Attached Chromes whose hold stays, as each still answers, or is not the one the workspace attaches to (Codex review L2). */
  chromes?: number
}

export function packDescriptor(pack: Pack): PackDescriptor {
  return {
    id: pack.id,
    version: pack.version,
    toolNames: pack.tools.map(tool => tool.capability.name),
    unavailableReason: pack.unavailableReason,
  }
}

export function availableTools(packs: Pack[]): RegisteredTool[] {
  return packs.filter(pack => pack.unavailableReason === null).flatMap(pack => pack.tools)
}

export function availableSkills(packs: Pack[]): LoadedSkill[] {
  return packs.filter(pack => pack.unavailableReason === null).flatMap(pack => pack.skills)
}
