import { z } from 'zod'
import { WorkspacePolicySchema } from '@5straps/protocol'
import type { PolicyStore } from '../../ports/policy-store.js'
import { createJsonFileStore } from '../json-file-store.js'

const fileSchema = z.object({
  version: z.literal(1),
  workspaces: z.record(z.string(), WorkspacePolicySchema),
})

/**
 * One file per machine, keyed by workspace root like the grants. It lives in the state
 * directory, which the permission rules refuse to every tool and the sandbox hides from every
 * command, so what constrains an agent is never something the agent can read or rewrite.
 */
export function createFilePolicyStore(input: { filePath: string; workspace: string }): PolicyStore {
  const store = createJsonFileStore({ filePath: input.filePath, schema: fileSchema, fallback: { version: 1 as const, workspaces: {} } })

  return {
    read: () => store.read().workspaces[input.workspace] ?? null,

    write(policy) {
      store.update(state => { state.workspaces[input.workspace] = policy })
    },

    clear() {
      store.update(state => { delete state.workspaces[input.workspace] })
    },
  }
}
