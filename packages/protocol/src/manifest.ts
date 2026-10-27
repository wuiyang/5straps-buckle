import { z } from 'zod'
import { SkillDescriptorSchema, ToolCapabilitySchema } from './tool.js'

export const PROTOCOL_VERSION = '2026-08-28' as const

export const SandboxModeSchema = z.enum(['none', 'bubblewrap', 'seatbelt'])
export type SandboxMode = z.infer<typeof SandboxModeSchema>

export const PackDescriptorSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  toolNames: z.array(z.string()),
  /** Populated when a pack is present but withheld, so operators can see why a tool is missing. */
  unavailableReason: z.string().nullable().default(null),
})
export type PackDescriptor = z.infer<typeof PackDescriptorSchema>

export const HarnessManifestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  serverId: z.string().min(1),
  name: z.string().min(1),
  /** One line naming the machine. Shown in pickers. */
  description: z.string().default(''),
  /** Prose telling a model when to prefer this node over its siblings. */
  usage: z.string().default(''),
  version: z.string().min(1),
  platform: z.object({
    os: z.string(),
    arch: z.string(),
    hostname: z.string(),
  }),
  sandbox: z.object({
    mode: SandboxModeSchema,
    /** True only when the operator explicitly accepted running unsandboxed. */
    acknowledgedUnsandboxed: z.boolean(),
  }),
  workspaceRoots: z.array(z.string()),
  tools: z.array(ToolCapabilitySchema),
  skills: z.array(SkillDescriptorSchema),
  packs: z.array(PackDescriptorSchema),
  limits: z.object({
    maxRequestBytes: z.number().int().positive(),
    defaultTimeoutMs: z.number().int().positive(),
    maxTimeoutMs: z.number().int().positive(),
    /** The largest file one copy moves through PUT and GET /v1/files; absent where the node offers no file copy. */
    maxTransferBytes: z.number().int().positive().optional(),
    /** What runs a content search: ripgrep, or the node's own walker where ripgrep is not installed; absent with no search. */
    searcher: z.enum(['rg', 'builtin']).optional(),
  }),
  generatedAt: z.iso.datetime(),
})
export type HarnessManifest = z.infer<typeof HarnessManifestSchema>
