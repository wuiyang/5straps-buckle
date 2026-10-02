import { HTTPError } from 'h3'
import { json } from '../../../../common/server/utils/respond.js'
import { useServices } from '../../../../common/server/utils/services.js'
import { defineSetupHandler } from '../../utils/setup.js'

// Opens a setup session for the key that signed this request (B24, approval-proofs.md: Setup
// activity). Later signed setup changes name it, and each one refreshes it; ten idle minutes close it.
export default defineSetupHandler({
  access: 'session',
  resource: 'sessions',
  handler: async ({ event, actor, workspace }) => {
    if (!actor.startsWith('key:')) throw HTTPError.status(400, 'Bad Request', { message: 'A setup session is for a request a person\'s enrolled key signs; the admin credential needs none' })
    const sessions = await useServices(event).getSetupSessions()
    return json({ session: await sessions.open({ keyId: actor.slice('key:'.length), workspaceId: workspace.runtime.workspaceId }) }, { status: 201 })
  },
})
