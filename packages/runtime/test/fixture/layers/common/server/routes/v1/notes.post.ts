import { setTimeout as delay } from 'node:timers/promises'
import { HTTPError } from 'h3'
import { registerBackgroundWork } from '@5straps/runtime'
import { defineGuardedHandler } from '@5straps/runtime/nitro'
import { requireAgent, useServices } from '../../utils/guards.js'

const MAX_NOTE_LENGTH = 1_000

export default defineGuardedHandler({
  guards: [requireAgent],
  handler: async (event, scope) => {
    const text = await readNoteText(event.req)
    const services = useServices(event)
    ;(await services.getOperation()).record('notes.add')
    const note = await (await services.getNotes()).add({ text, actor: scope.context.actor ?? 'unknown' })
    // Background work belongs to the request scope, which drains it before closing (F20).
    registerBackgroundWork(delay(25).then(() => event.context.logger?.info('note indexed', { noteId: note.id })))
    return new Response(JSON.stringify({ note, correlationId: scope.context.correlationId }), { status: 201, headers: { 'content-type': 'application/json' } })
  },
})

async function readNoteText(request: Request): Promise<string> {
  const body: unknown = await request.json().catch(() => undefined)
  const text = (body as { text?: unknown } | undefined)?.text
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_NOTE_LENGTH) throw HTTPError.status(400, 'Bad Request', { message: 'Invalid note' })
  return text
}
