import { z } from 'zod'
import type { Pack } from '../domain/pack.js'
import { createJsonFileStore } from './json-file-store.js'
import { logger } from '../runtime/log.js'

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

  return {
    list: () => store.read().plugins,

    add(entry) {
      const record: PluginEntry = { ...entry, enabled: true }
      store.update(state => { state.plugins = [...state.plugins.filter(plugin => plugin.id !== entry.id), record] })
      return record
    },

    remove(id) {
      return store.update(state => {
        const next = state.plugins.filter(plugin => plugin.id !== id)
        const changed = next.length !== state.plugins.length
        state.plugins = next
        return changed
      })
    },

    async load() {
      const packs: Pack[] = []
      for (const plugin of store.read().plugins.filter(entry => entry.enabled)) {
        packs.push(await loadOne(plugin, input.packOptions))
      }
      return packs
    },
  }
}

export const PLUGIN_UNAVAILABLE = 'The plugin failed to load; the node\'s log has the error'

/** A plugin that fails to load becomes a visibly unavailable pack rather than killing startup. */
async function loadOne(plugin: PluginEntry, packOptions: Record<string, unknown>): Promise<Pack> {
  try {
    const loaded: unknown = await import(plugin.specifier)
    if (!isPluginModule(loaded)) throw new Error('Plugin must export createPack(options)')
    return await loaded.createPack(packOptions)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    logger.error('Plugin failed to load', { id: plugin.id, specifier: plugin.specifier, message })
    // The message can hold the specifier's absolute path, and agents read this reason in the
    // manifest; the owner reads the error in the node's log.
    return { id: plugin.id, version: '0.0.0', tools: [], skills: [], unavailableReason: PLUGIN_UNAVAILABLE }
  }
}

function isPluginModule(value: unknown): value is PluginModule {
  return typeof value === 'object' && value !== null && 'createPack' in value && typeof value.createPack === 'function'
}

