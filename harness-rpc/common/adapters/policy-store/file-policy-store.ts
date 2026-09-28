import { policyRevision, PolicyConflictError } from '../../domain/policy.js'
import { z } from 'zod'
import { WorkspacePolicySchema } from '@5straps/protocol'
import type { PolicyStore } from '../../types/ports/policy-store.js'
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
export function createFilePolicyStore(input: { filePath: string; workspace: string; lockDeadlineMs?: number }): PolicyStore {
  const store = createJsonFileStore({ filePath: input.filePath, schema: fileSchema, fallback: { version: 1 as const, workspaces: {} }, lockDeadlineMs: input.lockDeadlineMs })

  return {
    read: () => store.read().workspaces[input.workspace] ?? null,

    async write(policy, expectedRevision) {
      await store.update(state => {
        if (expectedRevision !== undefined && policyRevision(state.workspaces[input.workspace] ?? null) !== expectedRevision) throw new PolicyConflictError('Workspace policy changed; reload before saving')
        state.workspaces[input.workspace] = policy
      })
    },

    async clear(expectedRevision) {
      await store.update(state => {
        if (expectedRevision !== undefined && policyRevision(state.workspaces[input.workspace] ?? null) !== expectedRevision) throw new PolicyConflictError('Workspace policy changed; reload before saving')
        delete state.workspaces[input.workspace]
      })
    },

    async update(change, expectedRevision) {
      await store.update(state => {
        const current = state.workspaces[input.workspace] ?? null
        if (expectedRevision !== undefined && policyRevision(current) !== expectedRevision) throw new PolicyConflictError('Workspace policy changed; reload before saving')
        const next = change(current)
        if (next) state.workspaces[input.workspace] = next
        else delete state.workspaces[input.workspace]
      })
    },
  }
}
