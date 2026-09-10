import { z } from 'zod'

export const SessionFeatureSchema = z.enum([
  'ai.model_calls',
  'ai.tool_calls',
  'ai.subagents',
  'harness.rpc',
  'mcp',
  'skills',
  'padding',
])
export type SessionFeature = z.infer<typeof SessionFeatureSchema>

export const BindingContractSchema = z.object({
  version: z.literal(1),
  unknownResourcePolicy: z.literal('deny'),
  features: z.record(SessionFeatureSchema, z.boolean()),
  resources: z.record(z.string(), z.boolean()),
})
export type BindingContract = z.infer<typeof BindingContractSchema>

/**
 * A request to change a binding, feature by feature and resource by resource. It is applied by
 * AND, so what it names can only be turned off; what it asks to turn on is a question for the
 * owner rather than a change.
 */
export const BindingPatchSchema = z.object({
  features: z.partialRecord(SessionFeatureSchema, z.boolean()).optional(),
  resources: z.record(z.string(), z.boolean()).optional(),
})
export type BindingPatch = z.infer<typeof BindingPatchSchema>

export function harnessToolResourceId(serverId: string, tool: string): string {
  return `harness:${serverId}:tool:${tool}`
}

export function harnessSkillResourceId(serverId: string, skillId: string): string {
  return `harness:${serverId}:skill:${skillId}`
}
