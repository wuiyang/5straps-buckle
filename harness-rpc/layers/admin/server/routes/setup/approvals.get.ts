import { defineSetupHandler } from '../../utils/setup.js'

export default defineSetupHandler({
  access: 'inspection',
  resource: 'approvals',
  handler: ({ workspace }) => ({ approvals: workspace.runtime.approvalService.pending() }),
})
