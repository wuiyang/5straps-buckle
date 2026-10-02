import type { PackDescriptor } from '@5straps/protocol'
import type { RegisteredTool } from './tool.js'
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
