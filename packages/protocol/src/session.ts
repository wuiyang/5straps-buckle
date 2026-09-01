import { z } from 'zod'
import { SessionFeatureSchema } from './binding.js'
import { JsonObjectSchema } from './json.js'

export const HarnessServerInputSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.url(),
  authToken: z.string().min(1),
})
export type HarnessServerInput = z.infer<typeof HarnessServerInputSchema>

export const CreateSessionInputSchema = z.object({
  title: z.string().min(1).max(200),
  defaultServerId: z.string().nullable().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
})
export type CreateSessionInput = z.infer<typeof CreateSessionInputSchema>

export const CreateSubchatInputSchema = z.object({
  parentChatId: z.string().min(1),
  title: z.string().min(1).max(200),
  task: z.string().min(1),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  defaultServerId: z.string().nullable().optional(),
  bindingPatch: z.object({
    features: z.record(SessionFeatureSchema, z.boolean()).optional(),
    resources: z.record(z.string(), z.boolean()).optional(),
  }).optional(),
})
export type CreateSubchatInput = z.infer<typeof CreateSubchatInputSchema>

export const RouteInvocationInputSchema = z.object({
  chatId: z.string().min(1),
  serverId: z.string().optional(),
  tool: z.string().min(1),
  args: JsonObjectSchema,
})
export type RouteInvocationInput = z.infer<typeof RouteInvocationInputSchema>
