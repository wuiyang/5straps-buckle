import type { ToolCapability } from '@5straps/protocol'
import type { RegisteredTool } from './tool.js'
import { ToolExecutionError } from './tool.js'

export interface ToolRegistry {
  capabilities(): ToolCapability[]
  has(name: string): boolean
  get(name: string): RegisteredTool
}

export function createToolRegistry(tools: RegisteredTool[]): ToolRegistry {
  const byName = new Map<string, RegisteredTool>()
  for (const tool of tools) {
    const existing = byName.get(tool.capability.name)
    if (existing) {
      throw new Error(
        `Duplicate tool ${tool.capability.name} from packs ${existing.capability.pack} and ${tool.capability.pack}`,
      )
    }
    byName.set(tool.capability.name, tool)
  }

  const sorted = [...byName.values()].sort((left, right) => left.capability.name.localeCompare(right.capability.name))

  return {
    capabilities: () => sorted.map(tool => tool.capability),
    has: name => byName.has(name),
    get(name) {
      const tool = byName.get(name)
      if (!tool) throw new ToolExecutionError(`Tool is not available: ${name}`, { code: 'TOOL_NOT_FOUND' })
      return tool
    },
  }
}
