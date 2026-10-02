import { WorkbenchProvisionSchema } from '@5straps/protocol'
import { SETUP_BODY_LIMIT } from '../../../../common/server/utils/body.js'
import { readWorkbenchBody, workbenchAnswer } from '../../../../common/server/utils/workbench.js'
import { defineSetupHandler } from '../../utils/setup.js'

// Provisioning needs the workspace enabled: a disabled one answers 409.
export default defineSetupHandler({
  access: 'setup',
  resource: 'workbenches',
  active: true,
  handler: ({ event, workspace }) => workbenchAnswer(event, async () => ({ workbench: await workspace.runtime.workbenches.provision(await readWorkbenchBody(event, WorkbenchProvisionSchema, SETUP_BODY_LIMIT)) })),
})
