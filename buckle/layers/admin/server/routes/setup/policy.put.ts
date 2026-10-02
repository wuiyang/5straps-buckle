import { defineSetupHandler } from '../../utils/setup.js'

// Replaces the stored policy against the revision the owner read: 409 when it changed since, or when
// the document names the dangerously-allow switch; 400 when the node refuses the policy. A write
// answers the same view as a read.
export default defineSetupHandler({
  access: 'setup',
  resource: 'policy',
  handler: async ({ event, workspace, views, body }) => {
    const { policy, expectedRevision } = views.policyUpdate(await body())
    await workspace.runtime.policy.apply(policy, expectedRevision)
    event.context.logger?.info('Workspace policy replaced through the setup face', { workspace: workspace.config.cwd })
    return views.policy(workspace)
  },
})
