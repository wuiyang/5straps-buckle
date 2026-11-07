import { JsonValueSchema, type JsonValue } from '@5straps/protocol'
import { z } from 'zod'
import type { RatingNote } from '../../types/ports/approval-backend.js'
import { FLOOR_WARNING } from './floor-note.js'

const levelSchema = z.enum(['safe', 'warning', 'danger'])
const quickNoteSchema = z.union([
  z.object({ level: levelSchema, confidence: z.number().min(0).max(1), model: z.string(), latencyMs: z.number().nonnegative() }).strict(),
  z.object({ unavailable: z.string() }).strict(),
])
const warning = { warning: z.literal(FLOOR_WARNING).optional() }
const judgeNoteSchema = z.union([
  z.object({ subject: z.string(), level: levelSchema, confidence: z.number().min(0).max(1), model: z.string(), reasoning: z.string(), latencyMs: z.number().nonnegative().optional(), quick: quickNoteSchema.optional(), ...warning }).strict(),
  z.object({ subject: z.string(), unavailable: z.string(), quick: quickNoteSchema.optional(), ...warning }).strict(),
  z.object({ subject: z.string(), onRequest: z.literal(true), ...warning }).strict(),
  z.object({ subject: z.string(), quick: quickNoteSchema, ...warning }).strict(),
]) satisfies z.ZodType<RatingNote>

/**
 * The whole call as the node's signed challenge shows it (owner decisions D9 and D17). `complete` marks a call recorded
 * whole; an ask recorded before it existed (with `truncated`, and perhaps cut arguments) is denied or joined by a re-send.
 * `judge` is what the decision AI's stages said of its command asks (D91), shown beside the action and never digested.
 */
export const askedCallSchema = z.object({
  arguments: JsonValueSchema, cwd: z.string(), description: z.string().nullable().default(null),
  effects: z.array(z.string()).optional(), complete: z.literal(true).optional(), truncated: z.boolean().optional(),
  judge: z.array(judgeNoteSchema).optional(),
})

export type AskedCall = z.infer<typeof askedCallSchema>

/** The whole call a relay or listing is handed where it was kept whole, else nothing (owner decision D17). */
export function shownCall(call: AskedCall | undefined): { arguments: JsonValue; cwd: string; description: string | null; effects: string[] } | undefined {
  return call?.complete ? { arguments: call.arguments, cwd: call.cwd, description: call.description, effects: call.effects ?? [] } : undefined
}
