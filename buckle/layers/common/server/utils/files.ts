import type { H3Event } from 'h3'
import type { InvokeRequest, InvokeResponse } from '@5straps/protocol'
import type { OutgoingFile } from '../../../../common/domain/tool.js'
import type { REQUEST_ALREADY_EXECUTED } from '../../../../common/services/invocation/executions.js'
import type { TRANSFER_TOO_LARGE } from '../../../../common/services/packs/fs/transfer.js'
import type { ActionLog } from '../../../../common/types/ports/action-log.js'
import { recordRefusal } from './audit.js'
import type { RefusalAudit } from './guards.js'
import { ANONYMOUS_SESSION_ID } from './invoke.js'
import { NODE_LEVEL } from './target.js'

// Checked against the common constants at compile time; the layers take common code as types only.
const TOO_LARGE: typeof TRANSFER_TOO_LARGE = 'TRANSFER_TOO_LARGE'
const ALREADY_EXECUTED: typeof REQUEST_ALREADY_EXECUTED = 'REQUEST_ALREADY_EXECUTED'

/** A copy over the node's limit is a 413 whichever check finds it; every other code answers as on /v1/invoke. */
export const FILES_STATUS: Readonly<Record<string, number>> = { [TOO_LARGE]: 413 }

/**
 * How long a copy's call is held for a person at most. node:http gives a request 300 seconds to arrive whole, and a
 * PUT's body waits unread behind its ask, so the hold and the upload after it share those seconds: this leaves the
 * upload 180 of them, where a PUT held past the 300 is cut by the server, never answered. A shorter wait of the
 * workspace's own holds as it is; one held until answered, or longer, answers approval_required at this bound, and
 * `buckle cp` sends it again under the same requestId.
 */
export const FILES_HOLD_MS = 120_000

/** The wait an entry point gives a copy's call: the workspace's own, at most FILES_HOLD_MS. */
export function filesWait(approvalTimeoutMs: number | null): { mode: 'finite'; ms: number } {
  return { mode: 'finite', ms: Math.max(1, Math.min(approvalTimeoutMs ?? FILES_HOLD_MS, FILES_HOLD_MS)) }
}

/** Refused before the invoker saw it: the credential in the guard, or the request's own headers and query in the route. */
export const FILES_REFUSED: RefusalAudit = {
  node: ({ actions, status }) => recordFilesRefusal(actions, NODE_LEVEL, status),
  named: 'workspace_files_rejected',
}

/** Records who was refused and the status, never the path, the body, or the credential. */
export function recordFilesRefusal(actions: ActionLog, workspaceId: string, status: number): void {
  recordRefusal(actions, { tool: 'rpc_files_rejected', workspaceId, sessionId: 'rpc-untrusted', status, detail: `HTTP ${status}` })
}

/** A files request as the route reads it, or why it is refused before any call: a status and words for the caller. */
export type FileRequest = { ok: true; request: InvokeRequest; sessionId: string } | { ok: false; status: number; error: string }

const DIGEST = /^[A-Fa-f0-9]{64}$/
/** A requestId as a header carries it: printable ASCII, as long as the audit log keeps one. */
const REQUEST_ID = /^[\x21-\x7e]{1,200}$/
const MAX_PATH = 4_096

/**
 * PUT /v1/files?path=<p>: one path, a content-length (a chunked body has none, so it is refused), at most the node's
 * limit, the body's sha256, and the requestId a re-send joins by. The call it makes is fs_receive({ path, bytes, sha256 }).
 */
export function receiveRequest(event: H3Event, maxTransferBytes: number): FileRequest {
  const path = onePath(event)
  if (typeof path !== 'string') return path
  const length = event.req.headers.get('content-length')
  if (length === null) return refused(411, 'Send the file with a content-length; a chunked body is not taken')
  if (!/^\d{1,16}$/.test(length.trim())) return refused(400, 'The content-length is not a number of bytes')
  const bytes = Number(length.trim())
  if (bytes > maxTransferBytes) return refused(413, `The file is ${bytes} bytes, more than the ${maxTransferBytes} this node copies at once (BUCKLE_MAX_TRANSFER_BYTES)`)
  const sha256 = event.req.headers.get('x-buckle-sha256')?.trim()
  if (!sha256 || !DIGEST.test(sha256)) return refused(400, 'Name the body\'s sha256 in x-buckle-sha256, as 64 hex characters')
  const requestId = event.req.headers.get('x-buckle-request-id')?.trim()
  if (!requestId || !REQUEST_ID.test(requestId)) return refused(400, 'Name the call in x-buckle-request-id, up to 200 printable characters, and send the same one again to join its ask')
  return { ok: true, request: { requestId, tool: 'fs_receive', args: { path, bytes, sha256: sha256.toLowerCase() }, approvalTokens: [] }, sessionId: sessionOf(event) }
}

/** GET /v1/files?path=<p>: one path, and a requestId where the caller sends one to join an ask by; a fresh one otherwise. */
export function sendRequest(event: H3Event): FileRequest {
  const path = onePath(event)
  if (typeof path !== 'string') return path
  const named = event.req.headers.get('x-buckle-request-id')?.trim()
  if (named !== undefined && !REQUEST_ID.test(named)) return refused(400, 'x-buckle-request-id takes up to 200 printable characters')
  return { ok: true, request: { requestId: named ?? crypto.randomUUID(), tool: 'fs_send', args: { path }, approvalTokens: [] }, sessionId: sessionOf(event) }
}

function onePath(event: H3Event): string | Extract<FileRequest, { ok: false }> {
  const paths = event.url.searchParams.getAll('path')
  if (paths.length !== 1 || paths[0] === '' || paths[0]!.length > MAX_PATH) return refused(400, 'Name one file with ?path=, up to 4096 characters')
  return paths[0]!
}

/** As /v1/invoke names a session: the caller's, else the one every caller that names none shares. */
function sessionOf(event: H3Event): string {
  return event.req.headers.get('x-buckle-session')?.trim() || ANONYMOUS_SESSION_ID
}

function refused(status: number, error: string): Extract<FileRequest, { ok: false }> {
  return { ok: false, status, error }
}

/**
 * What a GET answers where fs_send ran but no bytes went out: a re-send of a call that sent its file already, answered
 * with that call's outcome, whose bytes are not kept.
 */
export function alreadySent(response: Extract<InvokeResponse, { outcome: 'ok' }>): InvokeResponse {
  return { requestId: response.requestId, outcome: 'error', error: { code: ALREADY_EXECUTED, message: 'This requestId already sent its file, and its bytes are not kept for a re-send; send the request again with a new x-buckle-request-id', retryable: false } }
}

/** A file fs_send handed on: its size and digest, which go out ahead of it, and its bytes. */
export interface ReadyFile { size: number; sha256: string; stream: ReadableStream<Uint8Array> }

/**
 * The response side of fs_send's channel: `ready` resolves once the tool has the file open and hashed, and the stream
 * pulls its chunks one at a time as the caller reads. The tool's `send` settles when the last chunk is handed on, or
 * with the failure that cut the stream: a chunk that failed, the caller who left, or the call's own end (its timeout,
 * the shutdown), which cuts the response and settles the send though the caller holds the connection and reads nothing.
 */
export function outgoingFile(): { channel: OutgoingFile; ready: Promise<ReadyFile> } {
  let announce: (file: ReadyFile) => void = () => {}
  const ready = new Promise<ReadyFile>((resolve) => { announce = resolve })
  const channel: OutgoingFile = {
    kind: 'send',
    send: file => new Promise<void>((resolve, reject) => {
      const chunks = file.chunks[Symbol.asyncIterator]()
      let responseStream: ReadableStreamDefaultController<Uint8Array> | undefined
      const ended = () => file.signal.removeEventListener('abort', cut)
      const cut = () => {
        ended()
        try { responseStream?.error(file.signal.reason) } catch { /* Closed already. */ }
        reject(file.signal.reason)
        void chunks.return?.(undefined)
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) { responseStream = controller },
        async pull(controller) {
          try {
            const next = await chunks.next()
            if (next.done) {
              ended()
              controller.close()
              resolve()
            } else controller.enqueue(next.value)
          } catch (error) {
            ended()
            controller.error(error)
            reject(error)
          }
        },
        async cancel(reason) {
          ended()
          reject(reason instanceof Error ? reason : new Error('The caller left before the whole file was sent'))
          await chunks.return?.(undefined)
        },
      }, { highWaterMark: 0 })
      if (file.signal.aborted) cut()
      else file.signal.addEventListener('abort', cut, { once: true })
      announce({ size: file.size, sha256: file.sha256, stream: body })
    }),
  }
  return { channel, ready }
}
