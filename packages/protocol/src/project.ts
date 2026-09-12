import { z } from 'zod'

export const ProjectMountSchema = z.object({
  serverId: z.string().min(1),
  workspaceId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/).default('default'),
  role: z.string().max(100).default(''),
  responsibility: z.string().max(10_000).default(''),
})
export const ProjectSkillSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),
  name: z.string().min(1).max(200),
  content: z.string().min(1).max(100_000),
})
export const ProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  instructions: z.string().max(100_000).default(''),
  mounts: z.array(ProjectMountSchema).max(100).default([]),
  allowedSkills: z.array(z.string().min(1).max(500)).max(500).default([]),
  skills: z.array(ProjectSkillSchema).max(100).default([]),
})
export const ProjectPatchSchema = ProjectInputSchema.partial().extend({ expectedUpdatedAt: z.iso.datetime().optional() })
export const ProjectSchema = ProjectInputSchema.extend({
  id: z.string(), createdAt: z.string(), updatedAt: z.string(),
})
export type ProjectInput = z.infer<typeof ProjectInputSchema>
export type ProjectPatch = z.infer<typeof ProjectPatchSchema>
export type ProjectRecord = z.infer<typeof ProjectSchema>
export type ProjectMount = z.infer<typeof ProjectMountSchema>

export function workspaceToolResourceId(serverId: string, workspaceId: string, tool: string): string {
  return workspaceId === 'default' ? `harness:${serverId}:tool:${tool}` : `harness:${serverId}:workspace:${workspaceId}:tool:${tool}`
}
export function projectSkillResourceId(projectId: string, skillId: string): string {
  return `project:${projectId}:skill:${skillId}`
}

export function workspaceSkillResourceId(serverId: string, workspaceId: string, skillId: string): string {
  return workspaceId === 'default' ? `harness:${serverId}:skill:${skillId}` : `harness:${serverId}:workspace:${workspaceId}:skill:${skillId}`
}
