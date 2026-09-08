import { z } from 'zod'
import { RunEventSchema } from './runs.js'

/**
 * The run stream: one socket per client, carrying committed run events and the live model text
 * that is never stored. A browser cannot set a header on a socket and a token in the URL would
 * land in logs, so the credential arrives in the first frame and nothing else is accepted until
 * it does.
 */

/** The close code for a socket that never authenticated, or authenticated with the wrong token. */
export const STREAM_UNAUTHORIZED_CLOSE_CODE = 4401

export const StreamAuthFrameSchema = z.object({ type: z.literal('auth'), token: z.string().min(1) })

/**
 * `afterEventId` is the last committed event the client has applied for this chat, and null when
 * it holds none. Replay starts after it, so a reconnecting client is never sent a row twice.
 */
export const StreamSubscribeFrameSchema = z.object({
  type: z.literal('subscribe'),
  chatId: z.string().min(1),
  afterEventId: z.number().int().nonnegative().nullable(),
})

export const StreamUnsubscribeFrameSchema = z.object({ type: z.literal('unsubscribe'), chatId: z.string().min(1) })

export const ClientStreamFrameSchema = z.discriminatedUnion('type', [
  StreamAuthFrameSchema,
  StreamSubscribeFrameSchema,
  StreamUnsubscribeFrameSchema,
])
export type ClientStreamFrame = z.infer<typeof ClientStreamFrameSchema>

/** Sent once the first frame carried the owner token. Nothing is replayed before it. */
export const StreamReadyFrameSchema = z.object({ type: z.literal('ready') })

/** One stored row, replayed on subscribe and then delivered live. `id` is the resync cursor. */
export const StreamEventFrameSchema = z.object({ type: z.literal('event'), event: RunEventSchema })

/**
 * One piece of an answer while the model is still writing it. A delta is never stored and never
 * replayed: a client that missed it rebuilds the same text from the committed events instead.
 */
export const StreamDeltaFrameSchema = z.object({
  type: z.literal('delta'),
  runId: z.string(),
  chatId: z.string(),
  text: z.string(),
  reasoning: z.string().optional(),
})

export const StreamErrorFrameSchema = z.object({ type: z.literal('error'), code: z.string(), message: z.string() })

export const ServerStreamFrameSchema = z.discriminatedUnion('type', [
  StreamReadyFrameSchema,
  StreamEventFrameSchema,
  StreamDeltaFrameSchema,
  StreamErrorFrameSchema,
])
export type ServerStreamFrame = z.infer<typeof ServerStreamFrameSchema>
export type StreamDeltaFrame = z.infer<typeof StreamDeltaFrameSchema>
export type StreamEventFrame = z.infer<typeof StreamEventFrameSchema>
