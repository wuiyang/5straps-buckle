import { z } from 'zod'
import { JsonObjectSchema } from './json.js'

/** MCP clients reject names outside this pattern, so it is the canonical shape everywhere. */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

export const ToolNameSchema = z.string().regex(
  TOOL_NAME_PATTERN,
  'Tool names must be lower_snake_case and at most 64 characters',
)

export const CapabilityRiskSchema = z.enum(['read', 'write', 'execute', 'network', 'admin'])
export type CapabilityRisk = z.infer<typeof CapabilityRiskSchema>

export const ToolCapabilitySchema = z.object({
  name: ToolNameSchema,
  description: z.string().min(1),
  inputSchema: JsonObjectSchema,
  risk: CapabilityRiskSchema,
  tags: z.array(z.string()).default([]),
  pack: z.string().min(1),
})
export type ToolCapability = z.infer<typeof ToolCapabilitySchema>

export const SkillDescriptorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  contentHash: z.string().min(1),
  pack: z.string().nullable().default(null),
})
export type SkillDescriptor = z.infer<typeof SkillDescriptorSchema>
