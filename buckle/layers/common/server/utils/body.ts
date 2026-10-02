import { HTTPError, type H3Event } from 'h3'

/** Every workbench route reads at most this much. */
export const WORKBENCH_BODY_LIMIT = 1_048_576
/** Every admin route reads at most this much. */
export const SETUP_BODY_LIMIT = 65_536

export function bodyTooLarge(): HTTPError {
  return HTTPError.status(413, 'Content Too Large', { message: 'Request body is too large' })
}

/**
 * The whole request body, refused with 413 once it passes the limit: at once for a declared length,
 * and while it streams for a chunked one, so nothing past the limit is held in memory. Read once per
 * request: a later read gets the same bytes.
 */
export async function readBody(event: H3Event, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  if (event.context.requestBody) return event.context.requestBody
  event.context.requestBody = await readStream(event, limit)
  return event.context.requestBody
}

async function readStream(event: H3Event, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = event.req.headers.get('content-length')
  if (declared !== null && Number(declared) > limit) throw bodyTooLarge()
  const stream = event.req.body
  if (!stream) return new Uint8Array()
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => undefined)
      throw bodyTooLarge()
    }
    chunks.push(value)
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

/** The body parsed as JSON, or undefined when it is not JSON, for the route to answer its own 400. */
export async function readJson(event: H3Event, limit: number): Promise<unknown> {
  const text = new TextDecoder().decode(await readBody(event, limit))
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}
