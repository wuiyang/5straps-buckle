import { z } from 'zod'
import { CapabilityRiskSchema } from './tool.js'
import { JsonObjectSchema } from './json.js'

export const ChatToolSchema = z.object({
  id: z.string(),
  name: z.string(),
  modelName: z.string().nullable(),
  description: z.string(),
  source: z.enum(['rings', 'buckle']),
  serverId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  risk: CapabilityRiskSchema.nullable(),
  inputSchema: JsonObjectSchema.nullable(),
  enabled: z.boolean(),
  reason: z.string().nullable(),
  syncable: z.boolean(),
})

export const ChatToolsCatalogSchema = z.object({
  chatId: z.string(),
  sessionId: z.string(),
  projectId: z.string(),
  tools: z.array(ChatToolSchema),
  mounts: z.array(z.object({
    serverId: z.string(), workspaceId: z.string(), name: z.string(),
    role: z.string(), responsibility: z.string(), reason: z.string().nullable(),
  })),
  gateway: z.object({ configured: z.boolean(), toolCalling: z.boolean(), reason: z.string().nullable() }),
  sync: z.object({ allowed: z.boolean(), reason: z.string().nullable(), resourceIds: z.array(z.string()) }),
})

export type ChatTool = z.infer<typeof ChatToolSchema>
export type ChatToolsCatalog = z.infer<typeof ChatToolsCatalogSchema>
