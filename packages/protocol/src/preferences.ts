import { z } from 'zod'

export const UserPreferencesSchema = z.object({
  appearance: z.enum(['system', 'light', 'dark']).default('system'),
  defaultModel: z.string().trim().min(1).max(200).nullable().default(null),
  defaultEffort: z.string().trim().min(1).max(50).nullable().default(null),
  notifications: z.boolean().default(true),
  editor: z.object({
    fontSize: z.number().int().min(10).max(32).default(14),
    wordWrap: z.boolean().default(false),
    minimap: z.boolean().default(true),
  }).default({ fontSize: 14, wordWrap: false, minimap: true }),
}).strict()
export type UserPreferences = z.infer<typeof UserPreferencesSchema>
export const UserProfilePatchSchema = z.object({
  displayName: z.string().trim().min(1).max(100).optional(),
  preferences: UserPreferencesSchema.optional(),
  expectedUpdatedAt: z.string().optional(),
}).strict()
export type UserProfilePatch = z.infer<typeof UserProfilePatchSchema>
export interface UserProfile { displayName: string; preferences: UserPreferences; updatedAt: string }
