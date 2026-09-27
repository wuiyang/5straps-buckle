import { setTimeout as delay } from 'node:timers/promises'
import { HTTPError } from 'h3'
import { registerBackgroundWork } from '@5straps/runtime'
import { defineGuardedHandler } from '@5straps/runtime/nitro'
import { requireAgent, useServices } from '../../utils/guards.js'

const MAX_NOTE_LENGTH = 1_000
const DEFAULT_INDEX_DELAY_MS = 25
const MAX_INDEX_DELAY_MS = 2_000

export default defineGuardedHandler({
  guards: [requireAgent],
  handler: async (event, scope) => {
    const { text, indexDelayMs } = await readNote(event.req)
    const services = useServices(event)
    ;(await services.getOperation()).record('notes.add')
    const note = await (await services.getNotes()).add({ text, actor: scope.context.actor ?? 'unknown' })
    // Background work belongs to the request scope, which drains it before closing (F20, F22).
    registerBackgroundWork(delay(indexDelayMs).then(() => event.context.logger?.info('note indexed', { noteId: note.id })))
    return new Response(JSON.stringify({ note, correlationId: scope.context.correlationId }), { status: 201, headers: { 'content-type': 'application/json' } })
  },
})

// indexDelayMs is test-only: it keeps the indexing job running long enough to be drained at shutdown (F22).
async function readNote(request: Request): Promise<{ text: string; indexDelayMs: number }> {
  const body = await request.json().catch(() => undefined) as { text?: unknown; indexDelayMs?: unknown } | undefined
  const text = body?.text
  const indexDelayMs = body?.indexDelayMs ?? DEFAULT_INDEX_DELAY_MS
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_NOTE_LENGTH) throw HTTPError.status(400, 'Bad Request', { message: 'Invalid note' })
  if (!Number.isInteger(indexDelayMs) || (indexDelayMs as number) < 0 || (indexDelayMs as number) > MAX_INDEX_DELAY_MS) throw HTTPError.status(400, 'Bad Request', { message: 'Invalid indexDelayMs' })
  return { text, indexDelayMs: indexDelayMs as number }
}
