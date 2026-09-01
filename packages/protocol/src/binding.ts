import { z } from 'zod'

export const SessionFeatureSchema = z.enum([
  'ai.model_calls',
  'ai.tool_calls',
  'ai.subagents',
  'harness.rpc',
  'mcp',
  'skills',
])
export type SessionFeature = z.infer<typeof SessionFeatureSchema>

export const BindingContractSchema = z.object({
  version: z.literal(1),
  unknownResourcePolicy: z.literal('deny'),
  features: z.record(SessionFeatureSchema, z.boolean()),
  resources: z.record(z.string(), z.boolean()),
})
export type BindingContract = z.infer<typeof BindingContractSchema>

export function harnessToolResourceId(serverId: string, tool: string): string {
  return `harness:${serverId}:tool:${tool}`
}

export function harnessSkillResourceId(serverId: string, skillId: string): string {
  return `harness:${serverId}:skill:${skillId}`
}
