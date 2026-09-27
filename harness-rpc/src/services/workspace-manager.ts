import { randomBytes } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import { WorkspacePolicySchema, emptyWorkspacePolicy } from '@5straps/protocol'
import { createJsonFileStore } from '../adapters/json-file-store.js'
import { createChildApprovalDelivery } from './approval-delivery.js'
import type { BuckleConfig } from '../config.js'
import { compilePolicy } from '../domain/policy.js'
import { createRuntime, type BuckleRuntime } from '../runtime.js'

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
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).refine(value => value !== 'default', 'default is reserved'),
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
export class WorkspaceError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) { super(message) }
}

export function createWorkspaceManager(input: { config: BuckleConfig; runtime: BuckleRuntime }) {
  const defaultRoot = realpathSync(input.config.cwd)
  const stateRoot = realpathSync(input.config.stateDirectory)
  const store = createJsonFileStore({ filePath: join(stateRoot, 'workspaces.json'), schema: RegistrySchema, fallback: { version: 1 as const, workspaces: [] } })
  const exposedRoots = [...input.config.mountReadOnlyPaths, ...(input.config.sandboxMounts ?? []).map(mount => mount.source), dirname(dirname(process.execPath)), '/usr', '/bin', '/sbin', '/lib', '/lib64'].map(path => { try { return realpathSync(path) } catch { return path } })
  const runtimes = new Map<string, Promise<ManagedWorkspace>>()
  const defaultDescriptor = (): WorkspaceDescriptor => ({ id: 'default', name: input.config.serverName, root: defaultRoot, enabled: true, default: true, retiredAt: null, updatedAt: null })

  function eligibility(path: string): { selectable: boolean; reason?: string } {
    try {
      const root = canonicalDirectory(path)
      assertNoHostExposure(root, exposedRoots)
      if ([defaultRoot, stateRoot, ...store.read().workspaces.map(workspace => workspace.root)].some(existing => overlaps(existing, root))) return { selectable: false, reason: 'Overlaps an existing workspace or Buckle state' }
      return { selectable: true }
    } catch (error) { return { selectable: false, reason: error instanceof WorkspaceError ? error.message : 'Directory is unavailable' } }
  }
  /** No credential ever names two workspaces, and none repeats one the node itself holds. */
  function assertCredentialIsNew(state: { workspaces: StoredWorkspace[] }, credential: string): void {
    const held = [input.config.authToken, input.config.adminToken, ...state.workspaces.flatMap(workspace => [workspace.adminToken, ...workspace.tokens.map(entry => entry.token)])].filter(Boolean)
    if (held.includes(credential)) throw new WorkspaceError('That credential is already in use on this node', 409)
  }

  const manager = {
    eligibility,
    list(): WorkspaceDescriptor[] { return [defaultDescriptor(), ...store.read().workspaces.map(describe)] },
    register(value: WorkspaceRegistration): WorkspaceDescriptor {
      const root = canonicalDirectory(value.root)
      assertNoHostExposure(root, exposedRoots)
      compilePolicy(value.policy)
      const at = new Date().toISOString()
      return store.update(state => {
        if (state.workspaces.some(workspace => workspace.id === value.id)) throw new WorkspaceError('Workspace ID already exists', 409)
        if ([defaultRoot, stateRoot, ...state.workspaces.map(workspace => workspace.root)].some(existing => overlaps(existing, root))) {
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
    addToken(id: string, options: { label?: string } = {}): WorkspaceAgentToken {
      const minted: WorkspaceAgentToken = { id: `t-${randomBytes(4).toString('hex')}`, token: randomBytes(24).toString('base64url'), label: options.label ?? '', createdAt: new Date().toISOString() }
      return store.update(state => {
        const workspace = requireStored(state, id)
        assertCredentialIsNew(state, minted.token)
        workspace.tokens.push(minted)
        return minted
      })
    },
    revokeToken(id: string, tokenId: string): boolean {
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
    /** Read on every request, so a token revoked a moment ago is refused by the mounted face. */
    agentTokens(id: string): string[] {
      if (id === 'default') return [input.config.authToken].filter(Boolean)
      return store.read().workspaces.find(item => item.id === id)?.tokens.map(entry => entry.token) ?? []
    },
    adminToken(id: string): string | null {
      if (id === 'default') return input.config.adminToken || null
      return store.read().workspaces.find(item => item.id === id)?.adminToken ?? null
    },
    async update(id: string, input: z.infer<typeof WorkspacePatchSchema> & { retired?: boolean }): Promise<WorkspaceDescriptor> {
      if (id === 'default') throw new WorkspaceError('The default workspace is controlled by the node process', 409)
      const resolved = await manager.resolve(id, { setup: true })
      return store.update(state => {
        const workspace = state.workspaces.find(item => item.id === id)
        if (!workspace) throw new WorkspaceError('Workspace not found', 404)
        if (input.expectedUpdatedAt !== undefined && workspace.updatedAt !== input.expectedUpdatedAt) throw new WorkspaceError('Workspace changed; reload before saving', 409)
        if ((input.retired || input.enabled === false) && resolved.runtime.hasActiveWork()) throw new WorkspaceError('Resolve active tools and staged work before disabling this workspace', 409)
        if (input.enabled === true && workspace.retiredAt && input.retired !== false) throw new WorkspaceError('Reactivate the retired workspace before enabling it', 409)
        if (input.name !== undefined) workspace.name = input.name
        if (input.enabled !== undefined) workspace.enabled = input.enabled
        if (input.retired !== undefined) { workspace.retiredAt = input.retired ? new Date().toISOString() : null; workspace.enabled = !input.retired }
        workspace.updatedAt = new Date(Math.max(Date.now(), Date.parse(workspace.updatedAt ?? '') + 1 || 0)).toISOString()
        resolved.config.serverName = workspace.name
        return describe(workspace)
      })
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
      assertNoHostExposure(workspace.root, exposedRoots)
      if (canonicalDirectory(workspace.root) !== workspace.root) throw new WorkspaceError('Workspace root changed; owner repair is required', 409)
      let pending = runtimes.get(id)
      if (!pending) {
        const config: BuckleConfig = {
          // `reportUrl`, `reportToken` and `approvalWebhook` come through this spread on purpose.
          // Every action a child reports carries its own workspaceId, and a notification from one
          // names the workspace whose `buckle approve --workspace` answers it. Clearing them, as
          // this did before, left a registered workspace out of the owner's audit trail and its
          // approvals announced to nobody.
          ...input.config,
          cwd: workspace.root,
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
        pending = createRuntime({ config, workspaceId: id, channel: approvals => createChildApprovalDelivery({ config, approvals, workspaceId: id }) }).then(runtime => ({ config, runtime }))
        runtimes.set(id, pending)
        void pending.catch(() => { runtimes.delete(id) })
      }
      return pending
    },
  }
  return manager
}

function requireStored(state: { workspaces: StoredWorkspace[] }, id: string): StoredWorkspace {
  const workspace = state.workspaces.find(item => item.id === id)
  if (!workspace) throw new WorkspaceError('Workspace not found', 404)
  return workspace
}

function describe(workspace: StoredWorkspace): WorkspaceDescriptor {
  return { id: workspace.id, name: workspace.name, root: workspace.root, enabled: workspace.enabled, default: false, retiredAt: workspace.retiredAt, updatedAt: workspace.updatedAt }
}

function canonicalDirectory(root: string): string {
  try {
    const canonical = realpathSync(root)
    if (!statSync(canonical).isDirectory()) throw new Error('Not a directory')
    return canonical
  } catch { throw new WorkspaceError('Workspace root must be an existing directory') }
}

function overlaps(left: string, right: string): boolean {
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child)
    return path === '' || !path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)
  }
  return contains(left, right) || contains(right, left)
}

function assertNoHostExposure(root: string, exposedRoots: string[]): void {
  if (exposedRoots.some(exposed => overlaps(exposed, root))) {
    throw new WorkspaceError('Workspace overlaps a host toolchain or read-only mount; narrow the host exposure first', 409)
  }
}
