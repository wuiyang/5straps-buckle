import { randomBytes } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'pathe'
import { z } from 'zod'
import { WorkspacePolicySchema, emptyWorkspacePolicy } from '@5straps/protocol'
import { createJsonFileStore, StateFileError } from '../../adapters/json-file-store.js'
import type { InteractionSource } from '../approvals/interaction.js'
import { actionsPath, type BuckleConfig } from '../../runtime/config.js'
import { compilePolicy } from '../../domain/policy.js'
import { comparablePath, ignoresCase, isDriveRoot, isInsideComparable, nativePath, WHOLE_DRIVE } from '../../domain/paths.js'
import { createRuntime, type BuckleRuntime } from './workspace-runtime.js'
import { tokenMatches } from '../access/tokens.js'
import { storedGrantMatches, workbenchesDirectory, workbenchGrant } from '../workbench/storage.js'
import type { ServiceFailure } from '../../types/service-failure.js'
import { NODE_SCOPE } from '../../types/ports/client-keys.js'

/** What a credential is compared against for a workspace id the registry does not hold: random, so nothing matches it. */
const ABSENT_TOKEN = Object.freeze({ id: '', token: randomBytes(24).toString('base64url') })

/** The code a transport tells an unreadable registry by, before it has authenticated anyone. */
export const WORKSPACE_REGISTRY_UNREADABLE = 'WORKSPACE_REGISTRY_UNREADABLE'
/** The id the node's own agent token (BUCKLE_AUTH_TOKEN) goes by, beside a workspace's minted ones. */
export const NODE_AGENT_TOKEN_ID = 'node'

const CredentialSchema = z.string().min(24).max(512)
const AgentTokenSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  token: CredentialSchema,
  label: z.string().trim().max(120).default(''),
  createdAt: z.string(),
})
export type WorkspaceAgentToken = z.infer<typeof AgentTokenSchema>
export interface WorkspaceTokenDescriptor { id: string; label: string; createdAt: string }

export const WorkspaceRegistrationSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).refine(value => value !== 'default', 'default is reserved')
    // A key enrolled with --workspace node covers the whole node, so no workspace may share the word (review items 9 and 22).
    .refine(value => value !== NODE_SCOPE, 'node is reserved: it names the whole node in a key\'s scope'),
  name: z.string().trim().min(1).max(120),
  root: z.string().min(1).max(4096).refine(isAbsolute, 'Workspace root must be absolute'),
  /** The workspace's first agent token. Later ones are minted with `buckle workspace token add`. */
  authToken: CredentialSchema,
  adminToken: CredentialSchema,
  policy: WorkspacePolicySchema.default(emptyWorkspacePolicy),
}).strict()
export type WorkspaceRegistration = z.infer<typeof WorkspaceRegistrationSchema>
export const WorkspacePatchSchema = z.object({ name: z.string().trim().min(1).max(120).optional(), enabled: z.boolean().optional(), expectedUpdatedAt: z.string().nullable().optional() }).strict()
export const WorkspaceTokenInputSchema = z.object({ label: z.string().trim().max(120).default('') }).strict()

const StoredWorkspaceSchema = z.object({
  id: z.string(), name: z.string(), root: z.string(), adminToken: CredentialSchema,
  tokens: z.array(AgentTokenSchema).min(1),
  policy: WorkspacePolicySchema.default(emptyWorkspacePolicy),
  enabled: z.boolean(), retiredAt: z.string().nullable().default(null), updatedAt: z.string().nullable().default(null),
})
const RegistrySchema = z.object({ version: z.literal(1), workspaces: z.array(StoredWorkspaceSchema) })
type StoredWorkspace = z.infer<typeof StoredWorkspaceSchema>

export interface WorkspaceDescriptor {
  id: string
  name: string
  root: string
  enabled: boolean
  default: boolean
  retiredAt: string | null
  updatedAt: string | null
}
export interface ManagedWorkspace {
  config: BuckleConfig
  runtime: BuckleRuntime
}
export class WorkspaceError extends Error implements ServiceFailure {
  readonly code: string = 'WORKSPACE_REFUSED'
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) { super(message) }
}

/** workspaces.json will not parse. Its message names the file and fields, so only the owner's routes may show it. */
export class WorkspaceRegistryError extends WorkspaceError {
  override readonly code = WORKSPACE_REGISTRY_UNREADABLE
}

// A registry the node cannot read is the owner's to repair: a 409 naming the file and fields, not a 500.
function registryStore(filePath: string, lockDeadlineMs?: number) {
  const store = createJsonFileStore({ filePath, schema: RegistrySchema, fallback: { version: 1 as const, workspaces: [] }, lockDeadlineMs })
  const repairable = (error: unknown): unknown => error instanceof StateFileError ? new WorkspaceRegistryError(error.message, 409) : error
  return {
    read() {
      try {
        return store.read()
      } catch (error) {
        throw repairable(error)
      }
    },
    update: <R>(change: (state: z.infer<typeof RegistrySchema>) => R) => store.update(change).catch((error: unknown) => { throw repairable(error) }),
  }
}

/** `platform`: the host's unless a test imitates another; on Windows a whole drive is never a workspace root. */
export function createWorkspaceManager(input: { config: BuckleConfig; runtime: BuckleRuntime; interaction?: InteractionSource; platform?: NodeJS.Platform }) {
  const platform = input.platform ?? process.platform
  const defaultRoot = nativePath(realpathSync.native(input.config.cwd))
  const stateRoot = nativePath(realpathSync.native(input.config.stateDirectory))
  const store = registryStore(join(stateRoot, 'workspaces.json'), input.config.stateLockDeadlineMs)
  const exposedRoots = [...input.config.mountReadOnlyPaths, ...(input.config.sandboxMounts ?? []).map(mount => mount.source), dirname(dirname(process.execPath)), '/usr', '/bin', '/sbin', '/lib', '/lib64'].map(path => { try { return nativePath(realpathSync.native(path)) } catch { return path } })
  const runtimes = new Map<string, Promise<ManagedWorkspace>>()
  const defaultDescriptor = (): WorkspaceDescriptor => ({ id: 'default', name: input.config.serverName, root: defaultRoot, enabled: true, default: true, retiredAt: null, updatedAt: null })

  function eligibility(path: string): { selectable: boolean; reason?: string } {
    try {
      const root = canonicalDirectory(path, platform)
      assertNoHostExposure(root, exposedRoots, platform)
      if ([defaultRoot, stateRoot, ...store.read().workspaces.map(workspace => workspace.root)].some(existing => overlaps(existing, root, platform))) return { selectable: false, reason: 'Overlaps an existing workspace or Buckle state' }
      return { selectable: true }
    } catch (error) { return { selectable: false, reason: error instanceof WorkspaceError ? error.message : 'Directory is unavailable' } }
  }
  /** No credential ever names two workspaces, and none repeats one the node itself holds. */
  /** Whether a registered workspace serves calls now: enabled and not retired. An unreadable registry counts it as serving, so a failure still shows. */
  function serving(id: string): boolean {
    try {
      const workspace = store.read().workspaces.find(item => item.id === id)
      return workspace !== undefined && workspace.enabled && !workspace.retiredAt
    } catch {
      return true
    }
  }
  function assertCredentialIsNew(state: { workspaces: StoredWorkspace[] }, credential: string): void {
    const held = [input.config.authToken, input.config.adminToken, ...state.workspaces.flatMap(workspace => [workspace.adminToken, ...workspace.tokens.map(entry => entry.token)])].filter(Boolean)
    if (held.includes(credential)) throw new WorkspaceError('That credential is already in use on this node', 409)
  }

  const manager = {
    eligibility,
    list(): WorkspaceDescriptor[] { return [defaultDescriptor(), ...store.read().workspaces.map(describe)] },
    register(value: WorkspaceRegistration): Promise<WorkspaceDescriptor> {
      const root = canonicalDirectory(value.root, platform)
      assertNoHostExposure(root, exposedRoots, platform)
      compilePolicy(value.policy)
      const at = new Date().toISOString()
      return store.update(state => {
        if (state.workspaces.some(workspace => workspace.id === value.id)) throw new WorkspaceError('Workspace ID already exists', 409)
        if ([defaultRoot, stateRoot, ...state.workspaces.map(workspace => workspace.root)].some(existing => overlaps(existing, root, platform))) {
          throw new WorkspaceError('Workspace roots must not overlap existing workspaces or Buckle state', 409)
        }
        if (value.authToken === value.adminToken) throw new WorkspaceError('Each workspace requires distinct execution and admin credentials', 409)
        assertCredentialIsNew(state, value.authToken)
        assertCredentialIsNew(state, value.adminToken)
        const workspace: StoredWorkspace = {
          id: value.id, name: value.name, root, adminToken: value.adminToken, policy: value.policy,
          tokens: [{ id: 'initial', token: value.authToken, label: 'Registered', createdAt: at }],
          enabled: true, retiredAt: null, updatedAt: at,
        }
        state.workspaces.push(workspace)
        return describe(workspace)
      })
    },
    /**
     * `BUCKLE-D12` keeps minting with the owner: the caller reaches this through the CLI or
     * through `/setup`, both of which the admin credential alone opens. The secret is returned
     * once and never again, so nothing but the caller ever holds it in the clear.
     */
    addToken(id: string, options: { label?: string } = {}): Promise<WorkspaceAgentToken> {
      const minted: WorkspaceAgentToken = { id: `t-${randomBytes(4).toString('hex')}`, token: randomBytes(24).toString('base64url'), label: options.label ?? '', createdAt: new Date().toISOString() }
      return store.update(state => {
        const workspace = requireStored(state, id)
        assertCredentialIsNew(state, minted.token)
        workspace.tokens.push(minted)
        return minted
      })
    },
    revokeToken(id: string, tokenId: string): Promise<boolean> {
      return store.update(state => {
        const workspace = requireStored(state, id)
        const remaining = workspace.tokens.filter(entry => entry.id !== tokenId)
        if (remaining.length === workspace.tokens.length) return false
        if (remaining.length === 0) throw new WorkspaceError('A workspace keeps at least one agent token; mint a replacement before revoking the last one', 409)
        workspace.tokens = remaining
        return true
      })
    },
    listTokens(id: string): WorkspaceTokenDescriptor[] {
      return requireStored(store.read(), id).tokens.map(entry => ({ id: entry.id, label: entry.label, createdAt: entry.createdAt }))
    },
    /**
     * Which of the workspace's agent tokens the authorization header presents, by its id, or null.
     * Read on every request, so a token revoked a moment ago is refused at once; an empty credential
     * never matches. Throws WorkspaceRegistryError when the registry cannot be read.
     */
    authenticateAgent(id: string, authorization: string | undefined): string | null {
      if (id === 'default') return input.config.authToken && tokenMatches(authorization, input.config.authToken) ? NODE_AGENT_TOKEN_ID : null
      const workspace = store.read().workspaces.find(item => item.id === id)
      // An unknown id is compared as a known one is, so timing does not tell them apart (review L11 of B20-B22).
      const matched = (workspace?.tokens ?? [ABSENT_TOKEN]).find(entry => tokenMatches(authorization, entry.token))
      return workspace && matched ? matched.id : null
    },
    /**
     * Whether the authorization header presents the workspace's admin credential, compared in constant
     * time. Throws WorkspaceRegistryError when the registry cannot be read.
     */
    authenticateAdmin(id: string, authorization: string | undefined): boolean {
      const credential = manager.adminToken(id)
      const matches = tokenMatches(authorization, credential ?? ABSENT_TOKEN.token)
      return credential !== null && matches
    },
    /**
     * Whether the authorization header presents the grant of one workbench in the workspace, checked
     * against the stored record in constant time. No runtime opens before it matches, so a disabled,
     * broken or unknown workspace and a wrong grant are one 401 (review L6 of B15-B17, L1 of
     * B18-B19); only an unreadable registry throws. A disabled or retired workspace then opens as the
     * owner's face opens it, so its grant holder, and only they, learn why the route refuses.
     */
    authenticateWorkbench(id: string, workbenchId: string, authorization: string | undefined): boolean {
      const token = workbenchGrant(authorization)
      const directory = token ? workbenchesOf(id) : null
      return directory !== null && storedGrantMatches({ directory, workbenchId, token: token! })
    },
    adminToken(id: string): string | null {
      if (id === 'default') return input.config.adminToken || null
      return store.read().workspaces.find(item => item.id === id)?.adminToken ?? null
    },
    async update(id: string, input: z.infer<typeof WorkspacePatchSchema> & { retired?: boolean }): Promise<WorkspaceDescriptor> {
      if (id === 'default') throw new WorkspaceError('The default workspace is controlled by the node process', 409)
      const resolved = await manager.resolve(id, { setup: true })
      const busy = input.retired || input.enabled === false ? await resolved.runtime.hasActiveWork() : false
      const described = await store.update(state => {
        const workspace = state.workspaces.find(item => item.id === id)
        if (!workspace) throw new WorkspaceError('Workspace not found', 404)
        if (input.expectedUpdatedAt !== undefined && workspace.updatedAt !== input.expectedUpdatedAt) throw new WorkspaceError('Workspace changed; reload before saving', 409)
        if (busy) throw new WorkspaceError('Resolve active tools and staged work before disabling this workspace', 409)
        if (input.enabled === true && workspace.retiredAt && input.retired !== false) throw new WorkspaceError('Reactivate the retired workspace before enabling it', 409)
        if (input.name !== undefined) workspace.name = input.name
        if (input.enabled !== undefined) workspace.enabled = input.enabled
        if (input.retired !== undefined) { workspace.retiredAt = input.retired ? new Date().toISOString() : null; workspace.enabled = !input.retired }
        workspace.updatedAt = new Date(Math.max(Date.now(), Date.parse(workspace.updatedAt ?? '') + 1 || 0)).toISOString()
        resolved.config.serverName = workspace.name
        return describe(workspace)
      })
      // A retired or disabled workspace serves no call, so its log no longer holds the node's readiness (review L5 of B20-B22).
      if (!described.enabled) resolved.runtime.auditHealth.forget(actionsPath(resolved.config))
      return described
    },
    async setEnabled(id: string, enabled: boolean): Promise<WorkspaceDescriptor> { return manager.update(id, { enabled }) },
    known(id: string): boolean {
      return id === 'default' || store.read().workspaces.some(item => item.id === id)
    },
    async resolve(id: string, options: { setup?: boolean } = {}): Promise<ManagedWorkspace> {
      if (id === 'default') return input
      const workspace = store.read().workspaces.find(item => item.id === id)
      if (!workspace) throw new WorkspaceError('Workspace not found', 404)
      if (!options.setup && (!workspace.enabled || workspace.retiredAt)) throw new WorkspaceError('Workspace is disabled or retired', 409)
      assertNoHostExposure(workspace.root, exposedRoots, platform)
      // A root stored before roots were named in the disk's case still loads, in that case (review M1 of the second re-review).
      const root = canonicalDirectory(workspace.root, platform)
      if (comparablePath(root) !== comparablePath(workspace.root)) throw new WorkspaceError('Workspace root changed; owner repair is required', 409)
      let pending = runtimes.get(id)
      if (!pending) {
        const config: BuckleConfig = {
          // `reportUrl`, `reportToken` and `approvalWebhook` come through this spread on purpose.
          // Every action a child reports carries its own workspaceId, and a notification from one
          // names the workspace whose `buckle approve --workspace` answers it. Clearing them, as
          // this did before, left a registered workspace out of the owner's audit trail and its
          // approvals announced to nobody.
          ...input.config,
          cwd: root,
          serverName: workspace.name,
          authToken: workspace.tokens[0]!.token,
          adminToken: workspace.adminToken,
          stateDirectory: join(stateRoot, 'workspaces', workspace.id),
          nodeStateDirectory: stateRoot,
          scratchRoots: [],
          // Owner credential mounts belong only to the directly configured workspace.
          sandboxMounts: [],
          skillDirectories: [],
          strictWrites: true,
          // Every registered workspace has a hard path boundary, independent of grants.
          policy: { ...workspace.policy, mount: '/workspace' },
          nodePolicy: structuredClone(input.config.policy),
        }
        // One audit health per process: a registered workspace's log failing makes the node unready too.
        pending = createRuntime({ config, workspaceId: id, auditHealth: input.runtime.auditHealth, executionBudget: input.runtime.executionBudget,
          // The node's own switch is the ceiling this workspace's switch needs too (policy.md: ceilings must all permit).
          nodeDangerouslyAllowed: () => input.runtime.policy.dangerouslyAllow().on, serving: () => serving(id), ...(input.interaction ? { interaction: input.interaction } : {}) }).then(runtime => ({ config, runtime }))
        runtimes.set(id, pending)
        void pending.catch(() => { runtimes.delete(id) })
      }
      return pending
    },
    /** The registered workspaces opened so far, so their owner can close them. */
    async opened(): Promise<BuckleRuntime[]> {
      const settled = await Promise.allSettled([...runtimes.values()])
      return settled.flatMap(result => result.status === 'fulfilled' ? [result.value.runtime] : [])
    },
  }
  /** A known workspace's workbench directory, as its runtime would open it; null for an unknown one. */
  function workbenchesOf(id: string): string | null {
    if (id === 'default') return workbenchesDirectory({ stateDirectory: input.config.stateDirectory, root: input.config.cwd })
    const workspace = store.read().workspaces.find(item => item.id === id)
    return workspace ? workbenchesDirectory({ stateDirectory: join(stateRoot, 'workspaces', workspace.id), root: workspace.root }) : null
  }

  return manager
}
export type WorkspaceManager = ReturnType<typeof createWorkspaceManager>

function requireStored(state: { workspaces: StoredWorkspace[] }, id: string): StoredWorkspace {
  const workspace = state.workspaces.find(item => item.id === id)
  if (!workspace) throw new WorkspaceError('Workspace not found', 404)
  return workspace
}

function describe(workspace: StoredWorkspace): WorkspaceDescriptor {
  return { id: workspace.id, name: workspace.name, root: workspace.root, enabled: workspace.enabled, default: false, retiredAt: workspace.retiredAt, updatedAt: workspace.updatedAt }
}

/**
 * An existing directory as the disk names it: links followed, in the case the disk stores. On Windows a whole drive is
 * refused, as named and where it really is: every file on it would be the workspace's.
 */
function canonicalDirectory(root: string, platform: NodeJS.Platform): string {
  refuseWholeDrive(root, platform)
  let canonical: string
  try {
    canonical = realpathSync.native(root)
    if (!statSync(canonical).isDirectory()) throw new Error('Not a directory')
  } catch { throw new WorkspaceError('Workspace root must be an existing directory') }
  let named: string
  try { named = nativePath(canonical) } catch (error) { throw new WorkspaceError(error instanceof Error ? error.message : String(error)) }
  return refuseWholeDrive(named, platform)
}

function refuseWholeDrive(root: string, platform: NodeJS.Platform): string {
  if (isDriveRoot(root, platform)) throw new WorkspaceError(`Workspace root ${root}: ${WHOLE_DRIVE}`)
  return root
}

/** Whether either root holds the other, as the volume compares paths (a case variant of a root is that root on macOS). */
function overlaps(left: string, right: string, platform: NodeJS.Platform): boolean {
  return isInsideComparable(left, right, ignoresCase(platform), platform) || isInsideComparable(right, left, ignoresCase(platform), platform)
}

function assertNoHostExposure(root: string, exposedRoots: string[], platform: NodeJS.Platform): void {
  if (exposedRoots.some(exposed => overlaps(exposed, root, platform))) {
    throw new WorkspaceError('Workspace overlaps a host toolchain or read-only mount; narrow the host exposure first', 409)
  }
}
