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
