import { resolveFilesystemAccess } from '../../domain/filesystem-policy.js'
import { sensitivePathReason } from '../../domain/permission/rules/sensitive-path-rule.js'
import { isRestrictive, refuseSwitchIn } from '../../domain/policy.js'
import { ApprovalWithdrawSchema, emptyWorkspacePolicy, WorkspacePolicyUpdateSchema, type ApprovalWithdraw, type WorkspacePolicy } from '@5straps/protocol'
import { actionsPath, NODE_FOLDER_WORKSPACE } from '../../runtime/config.js'
import type { ServiceFailure } from '../../types/service-failure.js'
import { WorkspacePatchSchema, WorkspaceRegistrationSchema, WorkspaceTokenInputSchema, type ManagedWorkspace, type WorkspaceManager, type WorkspaceRegistration } from '../workspaces/workspace-manager.js'
import { browseDirectories, DirectoryQuerySchema } from './directory-browser.js'
import { browserModeStatus } from '../packs/browser/mode.js'

/** A setup request the owner's face refuses before doing anything: HTTP 400 with a fixed message. */
export class SetupRequestError extends Error implements ServiceFailure {
  readonly code = 'SETUP_REQUEST_INVALID'
  readonly status = 400
}

type Query = Record<string, string>

/**
 * What the owner's face (layers/admin) reads and parses, in common so the routes hold no policy of
 * their own and take common code as types only (plan section B). Each takes the workspace it serves.
 */
export interface SetupViews {
  /** How the node is set up for this workspace: identity, root and mount, sandbox, packs, policy state. */
  status(workspace: ManagedWorkspace): Promise<Record<string, unknown>>
  /** The policy as the setup face shows it: effective, revision and stored. */
  policy(workspace: ManagedWorkspace): Record<string, unknown>
  /** One page of the workspace's files with the read and write access each has. */
  files(workspace: ManagedWorkspace, query: Query): Promise<Record<string, unknown>>
  /** One page of host directories, each marked whether it can become a workspace root. */
  directories(workspaces: WorkspaceManager, query: Query): Promise<Record<string, unknown>>
  /** A policy to store, with the revision it was written against; one that names the dangerously-allow switch is refused 409. */
  policyUpdate(body: unknown): { policy: WorkspacePolicy; expectedRevision?: string }
  /** Which call's asks to withdraw: one of its tokens, or its requestId and session. */
  approvalWithdraw(body: unknown): ApprovalWithdraw
  /** A workspace to register; a policy in it that names the dangerously-allow switch is refused 409. */
  registration(body: unknown): WorkspaceRegistration
  workspacePatch(body: unknown): ReturnType<typeof WorkspacePatchSchema.parse>
  tokenInput(body: unknown): ReturnType<typeof WorkspaceTokenInputSchema.parse>
}

/** `on`, or `withheld (<reason>)`: packs.code off, or packs.enabled leaving the pack out. */
function codeStatus(pack: { unavailableReason: string | null } | undefined): string {
  if (!pack) return 'withheld (the workspace setting packs.enabled leaves the code pack out)'
  return pack.unavailableReason === null ? 'on' : `withheld (${pack.unavailableReason})`
}

export function createSetupViews(): SetupViews {
  return {
    async status({ config, runtime }) {
      const manifest = runtime.manifest()
      const effective = runtime.policy.effective()
      return {
        serverId: config.serverId,
        /** Which of the node's workspaces this face serves, and the identity its reports carry. */
        workspaceId: runtime.workspaceId,
        name: config.serverName,
        version: manifest.version,
        workspace: { root: config.cwd, mount: effective.mount, displayRoot: runtime.paths().displayRoot },
        sandbox: manifest.sandbox,
        packs: manifest.packs,
        // Which browser browser_command drives, as a word and the setting that chose it, never the setting's value,
        // and why the pack is withheld when it is.
        browser: browserModeStatus(config, manifest.packs.find(pack => pack.id === 'browser')),
        // Code mode (owner decision D82): on, or withheld with the reason the manifest gives.
        code: codeStatus(manifest.packs.find(pack => pack.id === 'code')),
        policy: { restrictive: isRestrictive(effective), storedAt: runtime.policy.stored()?.updatedAt ?? null },
        reporting: runtime.reporter.configured,
        // Unavailable while this workspace's audit log refuses writes: its tool calls are refused until it is repaired (B19).
        audit: runtime.auditHealth.failing(actionsPath(config)) ? 'unavailable' : 'available',
        auditLastFailureAt: runtime.auditHealth.lastFailureAt(actionsPath(config)),
        // The node's own face names every workspace whose log keeps readiness at 503 (review L5 of B20-B22).
        ...(runtime.workspaceId === NODE_FOLDER_WORKSPACE ? { auditFailingWorkspaces: runtime.auditHealth.failingWorkspaces() } : {}),
        // Read-only here: only the owner's local `buckle policy dangerously-allow` changes it (ruling H1e).
        dangerouslyAllow: runtime.policy.dangerouslyAllow(),
        approvalEnvelope: config.ringsApprovalKey ? 'enabled' : 're-pair required',
        // Read as inspection reads: nothing is owned or recovered to answer it (review L4 of B15-B17).
        activeWork: runtime.inspectActiveWork(),
      }
    },

    policy: ({ runtime }) => ({
      effective: runtime.policy.effective(),
      dangerouslyAllow: runtime.policy.dangerouslyAllow(),
      revision: runtime.policy.revision(),
      stored: runtime.policy.stored(),
    }),

    // The workspace's policy is the one source (Q14): a file's base access is the empty policy's, and only a
    // protected file is locked, asking whatever the policy says.
    async files({ runtime }, query) {
      const parsed = DirectoryQuerySchema.safeParse({ ...query, path: query.path ?? '.' })
      if (!parsed.success) throw new SetupRequestError('Invalid directory request')
      const page = await browseDirectories({ ...parsed.data, workspaceRoot: runtime.paths().root, includeFiles: true })
      const policy = runtime.policy.effective()
      return { ...page, entries: page.entries.map((entry) => {
        const protectedFile = Boolean(sensitivePathReason(entry.path))
        const access = resolveFilesystemAccess({ path: entry.path, policy })
        const baseline = resolveFilesystemAccess({ path: entry.path, policy: emptyWorkspacePolicy() })
        return { ...entry, baseRead: protectedFile && baseline.read !== 'deny' ? 'ask' : baseline.read, baseWrite: protectedFile && baseline.write !== 'deny' ? 'ask' : baseline.write,
          read: protectedFile && access.read !== 'deny' ? 'ask' : access.read, write: protectedFile && access.write !== 'deny' ? 'ask' : access.write,
          readLocked: protectedFile, writeLocked: protectedFile,
        }
      }) }
    },

    async directories(workspaces, query) {
      const parsed = DirectoryQuerySchema.safeParse(query)
      if (!parsed.success) throw new SetupRequestError('Invalid directory request')
      return browseDirectories({ ...parsed.data, eligibility: workspaces.eligibility })
    },

    policyUpdate(body) {
      refuseSwitchIn(body)
      const parsed = WorkspacePolicyUpdateSchema.safeParse(body)
      // Field paths only, as the parse issues named them before: a value can be anything the caller sent.
      if (!parsed.success) throw new SetupRequestError(`Invalid workspace policy at ${[...new Set(parsed.error.issues.map(issue => issue.path.join('.') || '(root)'))].join(', ')}`)
      const { expectedRevision, ...policy } = parsed.data
      return expectedRevision === undefined ? { policy } : { policy, expectedRevision }
    },
    approvalWithdraw: body => parsedOr(ApprovalWithdrawSchema.safeParse(body), 'Invalid approval withdrawal: send {token} or {requestId, sessionId}'),
    registration(body) {
      refuseSwitchIn((body as { policy?: unknown } | null)?.policy)
      return parsedOr(WorkspaceRegistrationSchema.safeParse(body), 'Invalid workspace registration')
    },
    workspacePatch: body => parsedOr(WorkspacePatchSchema.safeParse(body), 'Invalid workspace settings'),
    tokenInput: body => parsedOr(WorkspaceTokenInputSchema.safeParse(body), 'Invalid workspace token request'),
  }
}

function parsedOr<T>(result: { success: true; data: T } | { success: false }, message: string): T {
  if (!result.success) throw new SetupRequestError(message)
  return result.data
}
