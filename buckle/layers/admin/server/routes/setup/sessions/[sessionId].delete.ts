import { getRouterParam, HTTPError } from 'h3'
import { noContent } from '../../../../../common/server/utils/respond.js'
import { notFound } from '../../../../../common/server/utils/errors.js'
import { useServices } from '../../../../../common/server/utils/services.js'
import { defineSetupSessionHandler } from '../../../utils/setup.js'

// Completion or logout closes a setup session at once (B24). Only its own key closes it, with a
// signed request; the owner closes every session of a key by revoking it (buckle keys revoke).
export default defineSetupSessionHandler({
  access: 'setup',
  resource: 'sessions',
  handler: async ({ event, actor, workspaceId }) => {
    if (!actor.startsWith('key:')) throw HTTPError.status(400, 'Bad Request', { message: 'A setup session is closed by a request its own key signs, or with its key by buckle keys revoke' })
    const sessions = await useServices(event).getSetupSessions()
    const id = getRouterParam(event, 'sessionId', { decode: true }) ?? ''
    if (!await sessions.close({ id, keyId: actor.slice('key:'.length), workspaceId })) throw notFound('No open setup session of this key has that id')
    return noContent()
  },
})
