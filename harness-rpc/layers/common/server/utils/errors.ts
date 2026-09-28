import { HTTPError } from 'h3'
import type { ServiceFailure } from '../../../../common/types/service-failure.js'

/** A common error that carries its code and HTTP status (common/types/service-failure.ts). */
export function isServiceFailure(error: unknown): error is ServiceFailure {
  const fields = error as Partial<ServiceFailure> | null
  return error instanceof Error && !HTTPError.isError(error) && typeof fields?.code === 'string' && typeof fields.status === 'number'
}

export function hasCode(error: unknown, code: string): boolean {
  return isServiceFailure(error) && error.code === code
}

/**
 * The HTTP error a failure answers with: an HTTPError as it is, a service failure by its own status
 * and message, and nothing else, which the error handler answers as an unhandled 500 and logs.
 */
export function toHttpError(error: unknown): unknown {
  if (!isServiceFailure(error)) return error
  return new HTTPError({ status: error.status, statusText: statusText(error.status), message: error.message })
}

/** Runs a service call, answering its failures by their status (plan section B: explicit error mapping). */
export async function mapFailures<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw toHttpError(error)
  }
}

export function unauthorized(): HTTPError {
  return HTTPError.status(401, 'Unauthorized')
}

/**
 * A 404 of Buckle's own, whose message may be shown. The router's own 404 carries no status text, and
 * its message echoes the full URL, so the error handler answers that one "Not Found" (server/error.ts).
 */
export function notFound(message = 'Not Found'): HTTPError {
  return HTTPError.status(404, 'Not Found', { message })
}

const STATUS_TEXT: Readonly<Record<number, string>> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 413: 'Content Too Large', 422: 'Unprocessable Content', 429: 'Too Many Requests', 503: 'Service Unavailable' }

function statusText(status: number): string {
  return STATUS_TEXT[status] ?? 'Error'
}
