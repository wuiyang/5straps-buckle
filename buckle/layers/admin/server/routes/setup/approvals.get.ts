import { defineSetupHandler } from '../../utils/setup.js'

// Each waiting request, as `buckle approvals --json` lists it: the whole call it came from, when that was kept
// whole (owner decision D17, review M1), carried once per request group, on its first ask, and named by `callRef`
// on each ask of the group (review M1 of the slice 5 re-review); an ask recorded before this build has neither.
export default defineSetupHandler({
  access: 'inspection',
  resource: 'approvals',
  handler: ({ workspace }) => ({
    approvals: workspace.runtime.approvalApi.listing(),
  }),
})
