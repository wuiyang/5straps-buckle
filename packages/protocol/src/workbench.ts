import { z } from 'zod'
import { JsonObjectSchema } from './json.js'

export const WorkbenchIdSchema = z.string().uuid()
export const WorkbenchActorSchema = z.string().min(1).max(200)
export const WorkbenchProvisionSchema = z.object({
  id: WorkbenchIdSchema, token: z.string().min(32).max(256),
  projectId: z.string().min(1).max(200), chatId: z.string().min(1).max(200),
  allowShell: z.boolean().default(false),
}).strict()
export type WorkbenchProvision = z.infer<typeof WorkbenchProvisionSchema>

export const WorkbenchStatusSchema = z.enum(['preparing', 'open', 'reviewing', 'applying', 'applied', 'discarded', 'interrupted', 'apply_uncertain'])
export const WorkbenchTerminalStatusSchema = z.enum(['running', 'stopping', 'exited', 'interrupted'])
export const WorkbenchTerminalSchema = z.object({
  id: z.string().uuid(), status: WorkbenchTerminalStatusSchema,
  createdAt: z.string(), exitedAt: z.string().nullable(), exitCode: z.number().nullable(),
  controllerId: WorkbenchActorSchema.nullable(), generation: z.number().int(), leaseExpiresAt: z.string().nullable(),
  cols: z.number().int(), rows: z.number().int(), lastSequence: z.number().int(),
})
export type WorkbenchTerminal = z.infer<typeof WorkbenchTerminalSchema>
export const WorkbenchRecordSchema = z.object({
  id: WorkbenchIdSchema, workspaceId: z.string(), projectId: z.string(), chatId: z.string(),
  status: WorkbenchStatusSchema, revision: z.number().int(), createdAt: z.string(), updatedAt: z.string(),
  allowShell: z.boolean(), terminals: z.array(WorkbenchTerminalSchema), reviewId: z.string().uuid().nullable(),
})
export type WorkbenchRecord = z.infer<typeof WorkbenchRecordSchema>
export const WorkbenchActorInputSchema = z.object({ actorId: WorkbenchActorSchema }).strict()
export const WorkbenchInvokeSchema = WorkbenchActorInputSchema.extend({ tool: z.string().min(1).max(100), args: JsonObjectSchema })
export const WorkbenchTerminalStartSchema = WorkbenchActorInputSchema.extend({
  cwd: z.string().min(1).max(4096).default('.'), cols: z.number().int().min(10).max(500).default(100), rows: z.number().int().min(2).max(200).default(30),
})
export const WorkbenchControlSchema = WorkbenchActorInputSchema.extend({
  action: z.enum(['acquire', 'renew', 'release', 'handoff']), generation: z.number().int().nonnegative().optional(), nextActorId: WorkbenchActorSchema.optional(),
})
export const WorkbenchTerminalInputSchema = WorkbenchActorInputSchema.extend({
  generation: z.number().int().nonnegative(), sequence: z.number().int().positive(), data: z.string().min(1).max(65_536),
})
export const WorkbenchTerminalResizeSchema = WorkbenchActorInputSchema.extend({
  generation: z.number().int().nonnegative(), cols: z.number().int().min(10).max(500), rows: z.number().int().min(2).max(200),
})
export const WorkbenchApplySchema = WorkbenchActorInputSchema.extend({ reviewId: z.string().uuid() })
export interface WorkbenchTerminalEvent { sequence: number; type: 'output' | 'exit'; data?: string; exitCode?: number | null; at: string }
export interface WorkbenchTerminalEvents { events: WorkbenchTerminalEvent[]; nextSequence: number; truncated: boolean; terminal: WorkbenchTerminal }
export interface WorkbenchChange { path: string; kind: 'created' | 'modified' | 'deleted'; before: string | null; after: string | null; binary: boolean }
export interface WorkbenchReview { id: string; workbenchId: string; revision: number; createdAt: string; changes: WorkbenchChange[] }
