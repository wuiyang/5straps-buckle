import { z } from 'zod'
import type { Pack } from '../domain/pack.js'
import { createJsonFileStore } from './json-file-store.js'
import { logger } from '../logger.js'

const entrySchema = z.object({
  id: z.string().min(1),
  specifier: z.string().min(1),
  enabled: z.boolean().default(true),
})
const fileSchema = z.object({ version: z.literal(1), plugins: z.array(entrySchema) })

export type PluginEntry = z.infer<typeof entrySchema>

export interface PluginRegistry {
  list(): PluginEntry[]
  add(entry: { id: string; specifier: string }): PluginEntry
  remove(id: string): boolean
  load(): Promise<Pack[]>
}

interface PluginModule {
  createPack: (input: Record<string, unknown>) => Pack | Promise<Pack>
}

export function createPluginRegistry(input: { filePath: string; packOptions: Record<string, unknown> }): PluginRegistry {
  const store = createJsonFileStore({ filePath: input.filePath, schema: fileSchema, fallback: { version: 1 as const, plugins: [] } })
  let plugins = store.read().plugins

  const persist = (): void => store.write({ version: 1, plugins })

  return {
    list: () => plugins,

    add(entry) {
      const record: PluginEntry = { ...entry, enabled: true }
      plugins = [...plugins.filter(plugin => plugin.id !== entry.id), record]
      persist()
      return record
    },

    remove(id) {
      const next = plugins.filter(plugin => plugin.id !== id)
      if (next.length === plugins.length) return false
      plugins = next
      persist()
      return true
    },

    async load() {
      const packs: Pack[] = []
      for (const plugin of plugins.filter(entry => entry.enabled)) {
        packs.push(await loadOne(plugin, input.packOptions))
      }
      return packs
    },
  }
}

/** A plugin that fails to load becomes a visibly unavailable pack rather than killing startup. */
async function loadOne(plugin: PluginEntry, packOptions: Record<string, unknown>): Promise<Pack> {
  try {
    const loaded: unknown = await import(plugin.specifier)
    if (!isPluginModule(loaded)) throw new Error('Plugin must export createPack(options)')
    return await loaded.createPack(packOptions)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    logger.error('Plugin failed to load', { id: plugin.id, specifier: plugin.specifier, message })
    return { id: plugin.id, version: '0.0.0', tools: [], skills: [], unavailableReason: message }
  }
}

function isPluginModule(value: unknown): value is PluginModule {
  return typeof value === 'object' && value !== null && 'createPack' in value && typeof value.createPack === 'function'
}

