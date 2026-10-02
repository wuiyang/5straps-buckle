import { z } from 'zod'
import type { DangerouslyAllowStore } from '../../types/ports/dangerously-allow-store.js'
import { createJsonFileStore } from '../json-file-store.js'

const fileSchema = z.object({
  version: z.literal(1),
  workspaces: z.record(z.string(), z.object({ on: z.literal(true), changedAt: z.iso.datetime() }).strict()),
})

/**
 * The switch in its own file beside policy.json, keyed by workspace root as that file is, and held
 * only while on. Like every state file it lives in the state directory, which the rules refuse to
 * every tool and the sandbox hides from every command.
 */
export function createFileDangerouslyAllowStore(input: { filePath: string; workspace: string; lockDeadlineMs?: number }): DangerouslyAllowStore {
  const store = createJsonFileStore({ filePath: input.filePath, schema: fileSchema, fallback: { version: 1 as const, workspaces: {} }, lockDeadlineMs: input.lockDeadlineMs })
  return {
    isOn: () => store.read().workspaces[input.workspace] !== undefined,
    async set(on) {
      await store.update((state) => {
        if (on) state.workspaces[input.workspace] = { on: true, changedAt: new Date().toISOString() }
        else delete state.workspaces[input.workspace]
      })
    },
  }
}
