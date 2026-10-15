import { randomBytes } from 'node:crypto'
import { existsSync, realpathSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'pathe'
import { z } from 'zod'
import { WorkspacePolicySchema } from '@5straps/protocol'
import type { InteractionSource } from '../approvals/interaction.js'
import { createFileActionLog } from '../../adapters/action-log/file-action-log.js'
import { switchKeys } from '../../adapters/policy-store/file-dangerously-allow-store.js'
import { actionsPath, dangerouslyAllowPath, NODE_FOLDER_WORKSPACE, realPathOf, workspaceConfig, type BuckleConfig, type NodeConfig } from '../../runtime/config.js'
import { comparablePath, ignoresCase, isInsideComparable, nativePath } from '../../domain/paths.js'
import { rootsOf } from '../../domain/executable.js'
import { logger } from '../../runtime/log.js'
import { createRuntime, type BuckleRuntime } from './workspace-runtime.js'
import { createNodeRoots, type NodeRoots } from './node-roots.js'
import { bearerDigest, digestMatches, mintToken, tokenDigest, tokenMatches } from '../access/tokens.js'
import { storedGrantMatches, WorkbenchError, workbenchesDirectory, workbenchGrant } from '../workbench/storage.js'
import { createAuditHealth } from '../audit/audit-health.js'
import { createExecutionBudget } from '../invocation/executions.js'
import { unmetPackPrerequisite } from '../packs/index.js'
import type { ActionLog } from '../../types/ports/action-log.js'
import { activeElsewhere, activeWorkDirectory } from './active-work.js'
import { migrateNode } from './migration.js'
import { openRegistry, touched, WorkspaceError, WorkspaceIdSchema, WorkspaceNameSchema, WorkspaceRegistryError, type Registry, type StoredWorkspace } from './registry.js'
import { assertNoHostExposure, canonicalDirectory, exposedRoots, overlaps } from './workspace-dirs.js'
import { defaultSettings, openSettingsFile, scopeOf, settingsPath, withPolicy, WORKSPACE_MOUNT_TARGET, type WorkspaceSettings } from './workspace-settings.js'

export { WorkspaceError, WorkspaceRegistryError, WORKSPACE_REGISTRY_UNREADABLE } from './registry.js'

/** Said where a workspace was registered again while its earlier registration's runtime has work: no path, as an agent reads it. */
const REGISTERED_AGAIN = 'This workspace was registered again while work under its earlier registration is active; it serves its new registration once that work is resolved, or after buckle serve restarts, so call again then'

/** A digest nothing hashes to, compared once more after the scan, so an empty registry costs a comparison too. */
const ABSENT_DIGEST = 'f'.repeat(64)

export const WorkspaceRegistrationSchema = z.object({
  // Workspace default is the node's own folder, which migration alone makes (Q15): its records share the node's directory.
  id: WorkspaceIdSchema.refine(value => value !== NODE_FOLDER_WORKSPACE, 'default is reserved: it names the node\'s own folder, which migration makes a workspace').optional(),
  name: WorkspaceNameSchema.optional(),
  dir: z.string().min(1).max(4096),
  policy: WorkspacePolicySchema.optional(),
}).strict()
export type WorkspaceRegistration = z.infer<typeof WorkspaceRegistrationSchema>
export const WorkspacePatchSchema = z.object({ name: WorkspaceNameSchema.optional(), online: z.boolean().optional(), expectedUpdatedAt: z.string().nullable().optional() }).strict()
export const WorkspaceTokenInputSchema = z.object({ label: z.string().trim().max(120).default('') }).strict()

export interface WorkspaceDescriptor {
  id: string
  name: string
  dir: string
  online: boolean
  /** How many agent tokens it holds; the tokens themselves are never shown again. */
  tokens: number
  revision: number
  updatedAt: string
}
export interface WorkspaceTokenDescriptor { id: string; label: string; createdAt: string }
/** A token as minted: the only time it is shown. */
export interface MintedToken extends WorkspaceTokenDescriptor { token: string }
export interface ManagedWorkspace {
  config: BuckleConfig
  runtime: BuckleRuntime
}
/** What a registration took up from a workspace removed under its id: its records, and whether its dangerously-allow switch is on. */
export interface TakenUp { dangerouslyAllow: boolean }
/** Who a bearer token is: the workspace it belongs to and its id there. */
export interface TokenOwner { workspaceId: string; tokenId: string }

/**
 * The roots of a node (NodeRoots): every workspace folder its registry holds, BUCKLE_SCRATCH_ROOTS, and the sources
 * of writable mounts. No program Buckle runs comes from any of them.
 */
export function nodeRootsOf(config: NodeConfig, platform: NodeJS.Platform = process.platform): NodeRoots {
  const registry = openRegistry({ stateDirectory: config.stateDirectory, lockDeadlineMs: config.stateLockDeadlineMs })
  // BUCKLE_MOUNTS shares every folder read-only today, so this is empty: it guards a writable mount added later.
  const writableMounts = (config.sandboxMounts ?? []).filter(mount => !mount.readOnly).map(mount => mount.source)
  return createNodeRoots({
    fixed: [...rootsOf('scratch root', config.scratchRoots), ...rootsOf('writable mount', writableMounts)],
    readRegistered: () => {
      try { return registry.read().workspaces.map(workspace => workspace.dir) }
      catch (error) { if (error instanceof WorkspaceRegistryError) return null; throw error }
    },
    platform,
  })
}

/** The node's workspaces (D83): migrates a node set up before the workspace model first (migrateNode), then serves the registry. */
export async function openWorkspaceManager(input: { config: NodeConfig; interaction?: InteractionSource; platform?: NodeJS.Platform; nodeRoots?: NodeRoots }): Promise<WorkspaceManager> {
  for (const notice of await migrateNode({ node: input.config, ...(input.platform ? { platform: input.platform } : {}) })) logger.warn(notice)
  const manager = createWorkspaceManager(input)
  await manager.nodeActions.recoverInterrupted()
  return manager
}

function createWorkspaceManager(input: { config: NodeConfig; interaction?: InteractionSource; platform?: NodeJS.Platform; nodeRoots?: NodeRoots }) {
  const node = input.config
  const platform = input.platform ?? process.platform
  const stateRoot = nativePath(realpathSync.native(node.stateDirectory))
  const lockDeadlineMs = node.stateLockDeadlineMs
  const store = openRegistry({ stateDirectory: node.stateDirectory, lockDeadlineMs })
  const nodeRoots = input.nodeRoots ?? nodeRootsOf(node, platform)
  const exposed = exposedRoots(node)
  // One audit health and one budget for kept responses per process, shared by every workspace.
  const auditHealth = createAuditHealth()
  const executionBudget = createExecutionBudget()
  /** The node's own log: refusals before any workspace is known, and registry changes. Workspace default writes it too. */
  const nodeActions: ActionLog = createFileActionLog(actionsPath(node), { lockDeadlineMs, health: auditHealth, workspaceId: 'node' })
  const runtimes = new Map<string, Promise<ManagedWorkspace>>()
  /** The registration each runtime was opened for: its folder as stored, and when it was made. */
  const registrations = new WeakMap<ManagedWorkspace, Pick<StoredWorkspace, 'dir' | 'createdAt'>>()
  const settingsOf = (id: string) => openSettingsFile({ filePath: settingsPath(node.stateDirectory, id), lockDeadlineMs })
  /** Whether records of a workspace by this id are still on disk, from one removed without --purge. */
  const leftover = (id: string) => id === NODE_FOLDER_WORKSPACE || existsSync(join(node.stateDirectory, 'workspaces', id))

  /** Whether a workspace serves calls now. An unreadable registry counts it as serving, so a failure still shows. */
  function serving(id: string): boolean {
    try { return store.read().workspaces.find(item => item.id === id)?.online === true } catch { return true }
  }

  function eligibility(path: string): { selectable: boolean; reason?: string } {
    try {
      const dir = canonicalDirectory(path, platform)
      assertNoHostExposure(dir, exposed, platform)
      if ([stateRoot, ...store.read().workspaces.map(workspace => workspace.dir)].some(existing => overlaps(existing, dir, platform))) return { selectable: false, reason: 'Overlaps an existing workspace or Buckle state' }
      return { selectable: true }
    } catch (error) { return { selectable: false, reason: error instanceof WorkspaceError ? error.message : 'Directory is unavailable' } }
  }

  const manager = {
    nodeActions,
    auditHealth,
    eligibility,
    list(): WorkspaceDescriptor[] { return store.read().workspaces.map(describe) },
    known(id: string): boolean { return store.read().workspaces.some(item => item.id === id) },
    serving,

    /**
     * Registers a folder as a workspace (D83 (2), `buckle workspace init`), online, with one agent token returned here
     * and never again. Its id is `id`, or one made from the folder's name that no workspace's records hold: a removed
     * workspace's grants and settings stay on disk (Q7), and only an owner who names that id takes them up again, as the
     * answer says, with whether its dangerously-allow switch is on. Its settings are the defaults, the folder at
     * /workspace, with `policy` and `settings` over them; naming either over records taken up is refused, as they
     * would be dropped (finding 36 of the Phase 1 review).
     */
    async create(value: WorkspaceRegistration & { label?: string; settings?: (defaults: WorkspaceSettings) => WorkspaceSettings }): Promise<{ workspace: WorkspaceDescriptor; token: MintedToken; takenUp: TakenUp | null }> {
      const named = WorkspaceRegistrationSchema.pick({ id: true, name: true }).safeParse({ id: value.id, name: value.name })
      if (!named.success) throw new WorkspaceError(`Invalid workspace: ${named.error.issues.map(issue => issue.message).join('; ')}`)
      const dir = canonicalDirectory(value.dir, platform)
      assertNoHostExposure(dir, exposed, platform)
      const minted: MintedToken = { id: 'initial', token: mintToken(), label: value.label ?? 'Registered', createdAt: new Date().toISOString() }
      const created = await store.update(async (state) => {
        if ([stateRoot, ...state.workspaces.map(workspace => workspace.dir)].some(existing => overlaps(existing, dir, platform))) {
          throw new WorkspaceError('A workspace folder must not hold, or sit inside, another workspace or Buckle state', 409)
        }
        const id = value.id ?? idFor(dir, state, leftover)
        if (state.workspaces.some(workspace => workspace.id === id)) throw new WorkspaceError(`Workspace ${id} already exists`, 409)
        const takenUp = leftover(id) ? { dangerouslyAllow: switchKeys(dangerouslyAllowPath({ stateDirectory: join(node.stateDirectory, 'workspaces', id) })).includes(id) } : null
        if (takenUp && (value.policy || value.settings)) {
          throw new WorkspaceError(`Workspace ${id}'s records from before it was removed stay in the state directory, and registering it takes them up, its settings among them, in place of the policy or settings named here. Register it without them, or take the records up and delete them first with buckle workspace remove ${id} --purge`, 409)
        }
        if (!existsSync(settingsPath(node.stateDirectory, id))) {
          const defaults = value.policy ? withPolicy(defaultSettings(), { ...value.policy, mount: WORKSPACE_MOUNT_TARGET }) : defaultSettings()
          await settingsOf(id).update(() => (value.settings ? value.settings(defaults) : defaults))
        }
        const workspace: StoredWorkspace = { id, name: value.name ?? basename(dir), dir, online: true, revision: 0, updatedAt: minted.createdAt, createdAt: minted.createdAt,
          tokens: [{ id: minted.id, sha256: tokenDigest(minted.token), label: minted.label, createdAt: minted.createdAt }] }
        state.workspaces.push(workspace)
        nodeRoots.take(state.workspaces.map(item => item.dir))
        return { workspace: describe(workspace), takenUp }
      })
      return { ...created, token: minted }
    },

    /**
     * `BUCKLE-D12` keeps minting with the owner: the caller reaches this through the CLI or through `/setup`, both the
     * owner's. The token is returned once; the registry keeps its digest alone.
     */
    addToken(id: string, options: { label?: string } = {}): Promise<MintedToken> {
      const minted: MintedToken = { id: `t-${randomBytes(4).toString('hex')}`, token: mintToken(), label: options.label ?? '', createdAt: new Date().toISOString() }
      return store.update((state) => {
        const workspace = requireStored(state, id)
        workspace.tokens.push({ id: minted.id, sha256: tokenDigest(minted.token), label: minted.label, createdAt: minted.createdAt })
        touched(workspace)
        return minted
      })
    },
    revokeToken(id: string, tokenId: string): Promise<boolean> {
      return store.update((state) => {
        const workspace = requireStored(state, id)
        const remaining = workspace.tokens.filter(entry => entry.id !== tokenId)
        if (remaining.length === workspace.tokens.length) return false
        if (remaining.length === 0) throw new WorkspaceError('A workspace keeps at least one agent token; mint a replacement before revoking the last one', 409)
        workspace.tokens = remaining
        touched(workspace)
        return true
      })
    },
    listTokens(id: string): WorkspaceTokenDescriptor[] {
      return requireStored(store.read(), id).tokens.map(entry => ({ id: entry.id, label: entry.label, createdAt: entry.createdAt }))
    },

    /**
     * The workspace and token id a bearer token belongs to, or null (the workspace-model brief, item 3). Every token of
     * every workspace is compared, in constant time, whichever matches, so neither an answer's text nor its timing tells
     * an unknown token from another workspace's. Read on every request, so a revoked token is refused at once. Throws
     * WorkspaceRegistryError when the registry cannot be read.
     */
    tokenOwner(authorization: string | undefined): TokenOwner | null {
      const presented = bearerDigest(authorization)
      let owner: TokenOwner | null = null
      for (const workspace of store.read().workspaces) {
        for (const token of workspace.tokens) {
          if (digestMatches(presented, token.sha256) && owner === null) owner = { workspaceId: workspace.id, tokenId: token.id }
        }
      }
      digestMatches(presented, ABSENT_DIGEST)
      return owner
    },
    /** The node's admin credential, the one admin credential of every workspace (D83), compared in constant time. */
    authenticateAdmin(authorization: string | undefined): boolean {
      const matches = tokenMatches(authorization, node.adminToken || mintToken())
      return node.adminToken !== '' && matches
    },
    /**
     * Whether the authorization header presents the grant of one workbench in the workspace, checked
     * against the stored record in constant time. No runtime opens before it matches, so a disabled,
     * broken or unknown workspace and a wrong grant are one 401 (review L6 of B15-B17, L1 of
     * B18-B19); only an unreadable registry throws.
     */
    authenticateWorkbench(id: string, workbenchId: string, authorization: string | undefined): boolean {
      const token = workbenchGrant(authorization)
      const directory = token ? workbenchesOf(id) : null
      return directory !== null && storedGrantMatches({ directory, workbenchId, token: token! })
    },

    /** Renames a workspace or sets it online or offline (D83 addendum (5)); going offline waits for its active work. */
    async update(id: string, patch: z.infer<typeof WorkspacePatchSchema>): Promise<WorkspaceDescriptor> {
      if (patch.online === false) await assertIdle(id, { refusal: 'Resolve active tools and staged work before taking this workspace offline', deletes: false })
      const opened = await openedRuntime(id)
      const described = await store.update((state) => {
        const workspace = requireStored(state, id)
        if (patch.expectedUpdatedAt !== undefined && workspace.updatedAt !== patch.expectedUpdatedAt) throw new WorkspaceError('Workspace changed; reload before saving', 409)
        if (patch.name !== undefined) workspace.name = patch.name
        if (patch.online !== undefined) workspace.online = patch.online
        touched(workspace)
        return describe(workspace)
      })
      if (opened) {
        opened.config.serverName = described.name
        // An offline workspace serves no call, so its log no longer holds the node's readiness (review L5 of B20-B22).
        if (!described.online) auditHealth.forget(actionsPath(opened.config))
      }
      return described
    },

    /**
     * Removes the registration alone, as removing an MCP server removes its config (D83 addendum (6), Q7): the folder is
     * never touched, and the workspace's records (settings, grants, history, audit) stay unless `purge` deletes them.
     * Workspace default is refused: migration alone makes that id, so nothing could take its records up again (findings
     * 6 and 16 of the Phase 1 review), and they share the node's own directory.
     */
    async remove(id: string, options: { purge?: boolean } = {}): Promise<WorkspaceDescriptor> {
      if (id === NODE_FOLDER_WORKSPACE) throw new WorkspaceError('Workspace default is the node\'s own folder from before workspaces: its id cannot be registered again, and its records share the node\'s state directory, so it is not removed. Stop serving it with buckle workspace disable default', 409)
      await assertIdle(id, { refusal: 'Resolve active tools and staged work before removing this workspace', deletes: options.purge === true })
      const opened = await openedRuntime(id)
      const removed = await store.update((state) => {
        const workspace = requireStored(state, id)
        state.workspaces = state.workspaces.filter(item => item.id !== id)
        nodeRoots.take(state.workspaces.map(item => item.dir))
        return describe(workspace)
      })
      const pending = runtimes.get(id)
      if (opened && pending) await drop(id, pending, opened)
      if (options.purge) rmSync(join(node.stateDirectory, 'workspaces', id), { recursive: true, force: true })
      return removed
    },

    /** The workspace's settings as stored; the defaults where it has none yet. */
    settings(id: string): WorkspaceSettings {
      requireStored(store.read(), id)
      return settingsOf(id).read()
    },
    /**
     * Validates the next settings whole and writes them; refused where they changed since `expectedRevision`, or name
     * a pack this node cannot build (the environment pack without BUCKLE_ENV_VALIDATOR_COMMAND).
     */
    async updateSettings(id: string, change: (current: WorkspaceSettings) => WorkspaceSettings, expectedRevision?: number): Promise<WorkspaceSettings> {
      requireStored(store.read(), id)
      return settingsOf(id).update((current) => {
        const next = change(current)
        const unmet = (next.packs.enabled ?? []).flatMap((pack) => { const reason = unmetPackPrerequisite(pack, node); return reason ? [`${pack} (${reason})`] : [] })
        if (unmet.length > 0) throw new WorkspaceError(`This node cannot build pack ${unmet.join(', ')}; set the prerequisite first, or leave the pack out`)
        return next
      }, expectedRevision)
    },

    async resolve(id: string, options: { setup?: boolean } = {}): Promise<ManagedWorkspace> {
      const registered = store.read().workspaces
      // Every folder the registry holds now, one registered from another process included, is one no program runs from.
      nodeRoots.take(registered.map(item => item.dir))
      const workspace = registered.find(item => item.id === id)
      if (!workspace) throw new WorkspaceError('Workspace not found', 404)
      if (!options.setup && !workspace.online) throw new WorkspaceError('Workspace is offline', 409)
      // The node's own folder was never held to the host exposure, which it may hold (a toolchain under the owner's home); every other folder is.
      if (id !== NODE_FOLDER_WORKSPACE) assertNoHostExposure(workspace.dir, exposed, platform)
      // A folder stored before folders were named in the disk's case still loads, in that case (review M1 of the second re-review).
      const dir = canonicalDirectory(workspace.dir, platform)
      if (comparablePath(dir) !== comparablePath(workspace.dir)) throw new WorkspaceError('Workspace folder changed; owner repair is required', 409)
      // At most twice round: a runtime opened for an earlier registration of this id is closed, and the next is this one's.
      for (;;) {
        let pending = runtimes.get(id)
        if (!pending) {
          const settings = settingsOf(id).read()
          // `reportUrl`, `reportToken` and `approvalWebhook` come with the node's settings on purpose: every action a
          // workspace reports carries its own workspaceId, and a notification names the workspace that answers it.
          const config = workspaceConfig(node, { id, name: workspace.name, dir, ...scopeOf(settings) })
          const opening: Promise<ManagedWorkspace> = createRuntime({ config, workspaceId: id, nodeRoots, auditHealth, executionBudget, serving: () => serving(id), ...(input.interaction ? { interaction: input.interaction } : {}) })
            .then((runtime) => {
              const managed = { config, runtime }
              registrations.set(managed, { dir: workspace.dir, createdAt: workspace.createdAt })
              return managed
            })
          runtimes.set(id, opening)
          void opening.catch(() => { if (runtimes.get(id) === opening) runtimes.delete(id) })
          pending = opening
        }
        const resolved = await pending
        const registration = registrations.get(resolved)
        if (registration?.dir === workspace.dir && registration.createdAt === workspace.createdAt) {
          // A rename from another process reaches the next answer.
          resolved.config.serverName = workspace.name
          return resolved
        }
        // Removed and registered again from another process: this runtime still serves the folder that was removed
        // (finding 2 of the Phase 1 review). It goes once its work is resolved; meanwhile the call waits, naming no path.
        if (await earlierHasWork(resolved.runtime)) throw new WorkspaceError(REGISTERED_AGAIN, 409)
        await drop(id, pending, resolved)
      }
    },

    /**
     * Closes the runtimes this process opened for workspaces the registry no longer holds or holds offline, once each
     * has no active work, so a removed workspace's browser, terminals, and language servers end with it. `buckle serve`
     * calls it at each look at the registry (finding 2).
     */
    async closeUnserved(): Promise<void> {
      let registered: StoredWorkspace[]
      // An unreadable registry is reported where the workspaces are listed; nothing is closed on a guess.
      try { registered = store.read().workspaces } catch (error) {
        if (error instanceof WorkspaceRegistryError) return
        throw error
      }
      for (const [id, pending] of [...runtimes]) {
        if (registered.some(workspace => workspace.id === id && workspace.online)) continue
        const opened = await pending.catch(() => null)
        if (opened && !await earlierHasWork(opened.runtime)) await drop(id, pending, opened)
      }
    },

    /**
     * The workspace a command means (D83 (4)): `workspace` by id, else the one whose folder holds `dir`, else the one
     * whose folder holds `cwd`. Refused with the ids, never a folder, where none does.
     */
    target(where: { workspace?: string; dir?: string; cwd: string }): string {
      if (where.workspace !== undefined) {
        requireStored(store.read(), where.workspace)
        return where.workspace
      }
      const state = store.read()
      const holding = holderOf(state, where.dir === undefined ? where.cwd : resolve(where.cwd, where.dir), platform)
      if (holding) return holding.id
      const ids = state.workspaces.map(workspace => workspace.id)
      const named = where.dir === undefined ? 'the current directory' : 'that directory'
      throw new WorkspaceError(ids.length === 0
        ? `No workspace holds ${named}, and this node has none yet: run buckle init, or buckle workspace init in the folder to serve`
        : `No workspace holds ${named}. Name one with --workspace <id> (${ids.join(', ')}), or run buckle workspace init in the folder to serve`, 404)
    },

    /** The workspaces opened so far, so their owner can close them. */
    async opened(): Promise<BuckleRuntime[]> {
      const settled = await Promise.allSettled([...runtimes.values()])
      return settled.flatMap(result => result.status === 'fulfilled' ? [result.value.runtime] : [])
    },
    /** Closes every workspace opened, for a command that opened them outside the services' close steps (`buckle init`). */
    async close(): Promise<void> {
      for (const runtime of await manager.opened()) await closeRuntime(runtime)
      runtimes.clear()
    },
  }

  /**
   * Refuses taking a workspace offline or removing it while it has work (findings 5 and 9 of the Phase 1 review): calls
   * another process marks as running, then what its runtime holds, opened here as 0.1 did where this process has not, so
   * staged shell results and open workbenches on disk are seen from the CLI too. A workspace that will not open runs
   * nothing here, and taking it offline or forgetting it deletes nothing, so that goes ahead; deleting its records waits
   * until it opens and shows none.
   */
  async function assertIdle(id: string, input: { refusal: string; deletes: boolean }): Promise<void> {
    requireStored(store.read(), id)
    if (activeElsewhere({ directory: activeWorkDirectory(node.stateDirectory, id) })) throw new WorkspaceError(input.refusal, 409)
    let opened = await openedRuntime(id)
    if (!opened) {
      try { opened = await manager.resolve(id, { setup: true }) } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        if (input.deletes) throw new WorkspaceError(`Workspace ${id} will not open, so its staged work cannot be checked before its records are deleted: ${reason}. Remove it without --purge, or repair it first`, 409)
        logger.warn('A workspace would not open to check its staged work; nothing of it is deleted, so the change goes ahead', { workspaceId: id, error })
        return
      }
    }
    if (await holdsWork(opened.runtime)) throw new WorkspaceError(input.refusal, 409)
  }

  /** Forgets and closes a runtime, where it is still the one this process holds for the id. */
  async function drop(id: string, pending: Promise<ManagedWorkspace>, opened: ManagedWorkspace): Promise<void> {
    if (runtimes.get(id) !== pending) return
    runtimes.delete(id)
    auditHealth.forget(actionsPath(opened.config))
    await closeRuntime(opened.runtime)
  }

  async function openedRuntime(id: string): Promise<ManagedWorkspace | null> {
    const pending = runtimes.get(id)
    return pending ? pending.catch(() => null) : null
  }

  /** A known workspace's workbench directory, as its runtime would open it; null for an unknown one. */
  function workbenchesOf(id: string): string | null {
    const workspace = store.read().workspaces.find(item => item.id === id)
    if (!workspace) return null
    const config = workspaceConfig(node, { id, name: workspace.name, dir: workspace.dir, ...scopeOf(defaultSettings()) })
    return workbenchesDirectory({ stateDirectory: config.stateDirectory, root: workspace.dir })
  }

  return manager
}
export type WorkspaceManager = ReturnType<typeof createWorkspaceManager>

function requireStored(state: Registry, id: string): StoredWorkspace {
  const workspace = state.workspaces.find(item => item.id === id)
  if (!workspace) throw new WorkspaceError(`No workspace has the id ${id}`, 404)
  return workspace
}

function describe(workspace: StoredWorkspace): WorkspaceDescriptor {
  return { id: workspace.id, name: workspace.name, dir: workspace.dir, online: workspace.online, tokens: workspace.tokens.length, revision: workspace.revision, updatedAt: workspace.updatedAt }
}

/**
 * The workspace whose folder holds `path`, the deepest where one holds another, as the volume compares paths. A path
 * that does not exist yet is named through its deepest existing folder, links followed, as the stored folders are, so
 * one spelled through a link resolves as the same path spelled without it does (finding 33 of the Phase 1 review).
 */
function holderOf(state: Registry, path: string, platform: NodeJS.Platform): StoredWorkspace | undefined {
  const real = realPathOf(path, platform)
  return state.workspaces
    .filter(workspace => isInsideComparable(workspace.dir, real, ignoresCase(platform), platform))
    .sort((left, right) => right.dir.length - left.dir.length)[0]
}

/** A workspace id from its folder's name: lower case, words joined by hyphens, numbered past one taken or whose records remain. */
function idFor(dir: string, state: Registry, leftover: (id: string) => boolean): string {
  const word = basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 56) || 'workspace'
  const taken = new Set(state.workspaces.map(workspace => workspace.id))
  const free = (candidate: string) => !taken.has(candidate) && !leftover(candidate) && WorkspaceIdSchema.safeParse(candidate).success
  if (free(word)) return word
  for (let index = 2; ; index++) if (free(`${word}-${index}`)) return `${word}-${index}`
}

/** Whether a workspace's runtime has work; its workbenches owned by another Buckle process are that process's work. */
async function holdsWork(runtime: BuckleRuntime): Promise<boolean> {
  try { return await runtime.hasActiveWork() } catch (error) {
    if (error instanceof WorkbenchError) return true
    throw error
  }
}

/**
 * Whether a runtime opened for a registration the registry no longer holds still has work. Its records may be purged:
 * hasActiveWork counts the calls running first, and only reads the records on disk once none is, so a record folder
 * that is gone leaves it nothing to wait for.
 */
async function earlierHasWork(runtime: BuckleRuntime): Promise<boolean> {
  try { return await runtime.hasActiveWork() } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

/** Shutdown's steps for one workspace removed while the node runs. */
async function closeRuntime(runtime: BuckleRuntime): Promise<void> {
  await runtime.approvalService.close()
  await runtime.cancelInvocations()
  await runtime.workbenches.stopTerminals()
  await runtime.closeSessions()
  await runtime.workbenches.close()
  await runtime.history.close()
}
