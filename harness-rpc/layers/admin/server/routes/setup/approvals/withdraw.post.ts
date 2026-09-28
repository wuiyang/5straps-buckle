import { defineSetupHandler } from '../../../utils/setup.js'

// The approval guard: withdraws one call's asks still waiting, named by a token or by its requestId
// and session, and tells Rings each was cancelled (owner decision D6). Rings calls it when a run is
// cancelled; a caller that only drops its connection leaves the asks pending (decision D4).
export default defineSetupHandler({
  access: 'approval',
  resource: 'approvals-withdraw',
  handler: async ({ workspace, views, body }) => ({ withdrawn: await workspace.runtime.approvalService.withdrawCall(views.approvalWithdraw((await body()) ?? null)) }),
})
