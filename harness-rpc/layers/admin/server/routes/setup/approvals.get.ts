import { defineSetupHandler } from '../../utils/setup.js'

// Each waiting request, with the whole call it came from when that was kept whole (owner decision D17, review M1),
// as `buckle approvals --json` lists it; an ask recorded before this build has no `call`.
export default defineSetupHandler({
  access: 'inspection',
  resource: 'approvals',
  handler: ({ workspace }) => ({
    approvals: workspace.runtime.approvalService.waiting().map(({ request, call }) => ({
      ...request,
      ...(call?.complete ? { call: { arguments: call.arguments, cwd: call.cwd, description: call.description, effects: call.effects ?? [] } } : {}),
    })),
  }),
})
