import { HTTPError, type H3Event } from 'h3'

/**
 * An owner history operation: its result, a restore conflict with its message (409), and any other
 * failure 422 with the cause in the log only.
 */
export async function historyAnswer(event: H3Event, run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run()
  } catch (error) {
    if (HTTPError.isError(error)) throw error
    const message = error instanceof Error ? error.message : 'Unknown error'
    event.context.logger?.warn('Owner history operation failed', { message })
    if (message.startsWith('Restore conflict:')) throw HTTPError.status(409, 'Conflict', { message })
    throw HTTPError.status(422, 'Unprocessable Content', { message: 'History operation failed; inspect local owner logs' })
  }
}
