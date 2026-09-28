import { WorkspacePolicyUpdateSchema } from '@5straps/protocol'
import { json } from '../../../../common/server/utils/respond.js'
import { defineSetupHandler } from '../../utils/setup.js'

// Replaces the stored policy against the revision the owner read: 409 when it changed since, 400 when
// the node refuses the policy. A write answers the same view as a read.
export default defineSetupHandler({
  access: 'setup',
  resource: 'policy',
  handler: async ({ event, workspace, views, body }) => {
    const parsed = WorkspacePolicyUpdateSchema.safeParse(await body())
    if (!parsed.success) return json({ error: 'Invalid workspace policy', issues: parsed.error.issues }, { status: 400 })
    const { expectedRevision, ...policy } = parsed.data
    await workspace.runtime.policy.apply(policy, expectedRevision)
    event.context.logger?.info('Workspace policy replaced through the setup face', { workspace: workspace.config.cwd })
    return views.policy(workspace)
  },
})
