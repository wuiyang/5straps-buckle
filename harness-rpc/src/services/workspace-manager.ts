import { realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import { WorkspacePolicySchema, emptyWorkspacePolicy } from '@5straps/protocol'
import { createJsonFileStore } from '../adapters/json-file-store.js'
import { createDeferredApprovalChannel } from '../adapters/approval/deferred-approval-channel.js'
import type { BuckleConfig } from '../config.js'
import { compilePolicy } from '../domain/policy.js'
import { createRuntime, type BuckleRuntime } from '../runtime.js'

export const WorkspaceRegistrationSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).refine(value => value !== 'default', 'default is reserved'),
  name: z.string().trim().min(1).max(120),
  root: z.string().min(1).max(4096).refine(isAbsolute, 'Workspace root must be absolute'),
  authToken: z.string().min(24).max(512),
  setupToken: z.string().min(24).max(512),
  policy: WorkspacePolicySchema.default(emptyWorkspacePolicy),
}).strict()
export const WorkspacePatchSchema = z.object({ name: z.string().trim().min(1).max(120).optional(), enabled: z.boolean().optional(), expectedUpdatedAt: z.string().nullable().optional() }).strict()
const StoredWorkspaceSchema = WorkspaceRegistrationSchema.extend({ enabled: z.boolean(), retiredAt: z.string().nullable().default(null), updatedAt: z.string().nullable().default(null) })
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
  const exposedRoots = [...input.config.mountReadOnlyPaths, dirname(dirname(process.execPath)), '/usr', '/bin', '/sbin', '/lib', '/lib64'].map(path => { try { return realpathSync(path) } catch { return path } })
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
  const manager = {
    eligibility,
    list(): WorkspaceDescriptor[] { return [defaultDescriptor(), ...store.read().workspaces.map(describe)] },
    register(value: z.infer<typeof WorkspaceRegistrationSchema>): WorkspaceDescriptor {
      const root = canonicalDirectory(value.root)
      assertNoHostExposure(root, exposedRoots)
      compilePolicy(value.policy)
      return store.update(state => {
        if (state.workspaces.some(workspace => workspace.id === value.id)) throw new WorkspaceError('Workspace ID already exists', 409)
        if ([defaultRoot, stateRoot, ...state.workspaces.map(workspace => workspace.root)].some(existing => overlaps(existing, root))) {
          throw new WorkspaceError('Workspace roots must not overlap existing workspaces or Buckle state', 409)
        }
        const tokens = [input.config.authToken, input.config.setupToken, ...state.workspaces.flatMap(workspace => [workspace.authToken, workspace.setupToken])].filter(Boolean)
        if (value.authToken === value.setupToken || tokens.includes(value.authToken) || tokens.includes(value.setupToken)) {
          throw new WorkspaceError('Each workspace requires distinct execution and setup credentials', 409)
        }
        const workspace: StoredWorkspace = { ...value, root, enabled: true, retiredAt: null, updatedAt: new Date().toISOString() }
        state.workspaces.push(workspace)
        return describe(workspace)
      })
    },
    async update(id: string, input: z.infer<typeof WorkspacePatchSchema> & { retired?: boolean }): Promise<WorkspaceDescriptor> {
      if (id === 'default') throw new WorkspaceError('The legacy default workspace is controlled by the node process', 409)
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
    credentials(id: string): { authToken: string; setupToken: string } | null {
      if (id === 'default') return { authToken: input.config.authToken, setupToken: input.config.setupToken }
      const workspace = store.read().workspaces.find(item => item.id === id)
      return workspace ? { authToken: workspace.authToken, setupToken: workspace.setupToken } : null
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
          ...input.config,
          cwd: workspace.root,
          serverName: workspace.name,
          authToken: workspace.authToken,
          setupToken: workspace.setupToken,
          stateDirectory: join(stateRoot, 'workspaces', workspace.id),
          nodeStateDirectory: stateRoot,
          scratchRoots: [],
          skillDirectories: [],
          // Legacy callbacks lack workspace identity; Rings routes scoped invocation approvals.
          reportUrl: undefined,
          reportToken: undefined,
          approvalWebhook: undefined,
          strictWrites: true,
          // Every registered workspace has a hard path boundary, independent of grants.
          policy: { ...workspace.policy, mount: '/workspace' },
          nodePolicy: structuredClone(input.config.policy),
        }
        pending = createRuntime({ config, workspaceId: id, channel: () => createDeferredApprovalChannel() }).then(runtime => ({ config, runtime }))
        runtimes.set(id, pending)
        void pending.catch(() => { runtimes.delete(id) })
      }
      return pending
    },
  }
  return manager
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
