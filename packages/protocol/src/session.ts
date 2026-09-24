import { z } from 'zod'
import { SessionFeatureSchema } from './binding.js'
import { JsonObjectSchema } from './json.js'
import { HarnessManifestSchema } from './manifest.js'

/**
 * `BUCKLE-08` renamed the setup token to the admin credential. A client still sending the old
 * field name is read for one release, so an unupgraded caller keeps registering its node.
 */
function renameLegacySetupToken(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const { setupToken, ...rest } = value as Record<string, unknown>
  if (setupToken === undefined) return value
  return { ...rest, adminToken: rest.adminToken ?? setupToken }
}

const HarnessServerFieldsSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.url(),
  authToken: z.string().min(1),
  /** The admin credential, kept apart from the agent's token, that lets Rings read and push the workspace policy, mint workspace tokens and decide approvals. */
  adminToken: z.string().min(1).optional(),
})
export const HarnessServerInputSchema = z.preprocess(renameLegacySetupToken, HarnessServerFieldsSchema)
export type HarnessServerInput = z.infer<typeof HarnessServerInputSchema>

/**
 * A node redeeming a pairing code, per `BUCKLE-D08: Onboarding is buckle init plus a pairing
 * code`. The code is the whole authority here, so it is short-lived and single use; the node's
 * URL, its credentials and the manifest it reports all travel in this one body rather than
 * being typed from one screen into another.
 */
export const HarnessPairingRedeemSchema = z.object({
  code: z.string().min(8).max(128),
  name: z.string().min(1).max(200),
  baseUrl: z.url(),
  authToken: z.string().min(1),
  adminToken: z.string().min(1).optional(),
  manifest: HarnessManifestSchema,
  /** `RINGS-D20`: the node opens sealed approval traffic, so Rings mints it a key. Absent on an older node. */
  approvalEnvelope: z.literal(1).optional(),
})
export type HarnessPairingRedeem = z.infer<typeof HarnessPairingRedeemSchema>

/**
 * Minting a pairing code. A code with no `serverId` onboards a Buckle Rings has never seen; one
 * naming a registered node is the owner's own authority to replace that node's connection, which
 * is how a moved node re-pairs when Rings no longer holds the admin credential it can present.
 * The body may be absent entirely, which is the plain new-node code Visual asks for.
 */
export const HarnessPairingIssueSchema = z.preprocess(value => value ?? {}, z.object({
  serverId: z.string().min(1).max(200).optional(),
}))
export type HarnessPairingIssue = z.infer<typeof HarnessPairingIssueSchema>

/** Editing a registered node: every field optional, guarded against a concurrent edit. */
export const HarnessServerPatchSchema = z.preprocess(renameLegacySetupToken, HarnessServerFieldsSchema.partial().extend({ expectedUpdatedAt: z.string().optional() }))
export type HarnessServerPatch = z.infer<typeof HarnessServerPatchSchema>

export const CreateSessionInputSchema = z.object({
  clientRequestId: z.string().uuid().optional(),
  projectId: z.string().min(1).optional(),
  maxActiveChildren: z.number().int().min(0).max(32).optional(),
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
  workspaceId: z.string().min(1).optional(),
  chatId: z.string().min(1),
  serverId: z.string().optional(),
  tool: z.string().min(1),
  args: JsonObjectSchema,
  /** Tokens of approvals already granted `once`, replayed so the retry clears the same gates. */
  approvalTokens: z.array(z.string()).default([]),
})
export type RouteInvocationInput = z.infer<typeof RouteInvocationInputSchema>

export const SessionPatchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  model: z.string().trim().min(1).max(300).optional(),
  reasoningEffort: z.string().trim().max(100).nullable().optional(),
  maxActiveChildren: z.number().int().min(0).max(32).optional(),
  archived: z.boolean().optional(),
})
export type SessionPatch = z.infer<typeof SessionPatchSchema>

export const AgentSettingsPatchSchema = SessionPatchSchema.pick({ model: true, reasoningEffort: true }).strict()
export type AgentSettingsPatch = z.infer<typeof AgentSettingsPatchSchema>
