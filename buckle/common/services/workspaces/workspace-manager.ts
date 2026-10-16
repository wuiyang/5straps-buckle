import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'pathe'
import { z } from 'zod'
import { WorkspacePolicySchema } from '@5straps/protocol'
import type { InteractionSource } from '../approvals/interaction.js'
import { createFileActionLog } from '../../adapters/action-log/file-action-log.js'
import { switchKeys } from '../../adapters/policy-store/file-dangerously-allow-store.js'
import { actionsPath, dangerouslyAllowPath, realPathOf, workspaceConfig, type BuckleConfig, type NodeConfig } from '../../runtime/config.js'
import { comparablePath, ignoresCase, isInsideComparable, nativePath } from '../../domain/paths.js'
import { rootsOf } from '../../domain/executable.js'
import { logger } from '../../runtime/log.js'
import { createRuntime, type BuckleRuntime } from './workspace-runtime.js'
import { createNodeRoots, type NodeRoots } from './node-roots.js'
import { bearerDigest, digestMatches, mintToken, tokenDigest, tokenMatches } from '../access/tokens.js'
import { storedGrantMatches, workbenchesDirectory, workbenchGrant } from '../workbench/storage.js'
import { createAuditHealth } from '../audit/audit-health.js'
import { createExecutionBudget } from '../invocation/executions.js'
import { unmetPackPrerequisite } from '../packs/index.js'
import type { ActionLog } from '../../types/ports/action-log.js'
import { activeElsewhere, activeWorkDirectory } from './active-work.js'
import { migrateNode, type AskName } from './migration.js'
import { openRegistry, sameName, touched, WorkspaceError, WorkspaceNameSchema, WorkspaceRegistryError, type Registry, type StoredWorkspace } from './registry.js'
import { assertNoHostExposure, canonicalDirectory, exposedRoots, overlaps } from './workspace-dirs.js'
import { NODE_SCOPE } from '../../types/ports/client-keys.js'
import { workspaceIdFor } from './workspace-id.js'
import { assertNodeDefaults, defaultSettings, openSettingsFile, scopeOf, settingsPath, withPolicy, type WorkspaceSettings } from './workspace-settings.js'

export { WorkspaceError, WorkspaceRegistryError, WORKSPACE_REGISTRY_UNREADABLE } from './registry.js'

/** A name another workspace holds already (D85, Q15): the owner is asked for another at a terminal, and refused without one. */
export class WorkspaceNameTakenError extends WorkspaceError {
  override readonly code = 'WORKSPACE_NAME_TAKEN'
  constructor(name: string) { super(`A workspace is already named ${name}; choose another name`, 409) }
}

/**
 * A name the registry would refuse, the folder's own or one given (D85, Q15): the owner is asked for another at a
 * terminal, and refused naming --name without one. Raised before anything is written, so a refused name leaves no records.
 */
export class WorkspaceNameRefusedError extends WorkspaceError {
  override readonly code = 'WORKSPACE_NAME_REFUSED'
  constructor(name: string, reasons: string, source: 'folder' | 'given') { super(`${source === 'folder' ? `The folder's name ${name}` : `The name ${name}`} cannot be a workspace name: ${reasons}`, 400) }
}

/** Said where a workspace was registered again while its earlier registration's runtime has work: no path, as an agent reads it. */
const REGISTERED_AGAIN = 'This workspace was registered again while work under its earlier registration is active; it serves its new registration once that work is resolved, or after buckle serve restarts, so call again then'

/** A digest nothing hashes to, compared once more after the scan, so an empty registry costs a comparison too. */
const ABSENT_DIGEST = 'f'.repeat(64)

export const WorkspaceRegistrationSchema = z.object({
  /** The 0.1 spelling of `name`: ids are assigned now (D85, Q15), and a registration that still sends one names its workspace by it. */
  id: WorkspaceNameSchema.optional(),
  name: WorkspaceNameSchema.optional(),
  dir: z.string().min(1).max(4096),
  policy: WorkspacePolicySchema.optional(),
  /** A folder whose removed records still exist starts a new id and leaves the old ones to prune, rather than taking them up (addendum to D85, Q15). */
  fresh: z.boolean().optional(),
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
/** A removed workspace whose records still sit in the state directory, as `buckle workspace prune` lists them. */
export interface RemovedWorkspace { id: string; dir: string; name: string; removedAt: string }
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
export async function openWorkspaceManager(input: { config: NodeConfig; interaction?: InteractionSource; platform?: NodeJS.Platform; nodeRoots?: NodeRoots; askName?: AskName }): Promise<WorkspaceManager> {
  assertNodeDefaults(input.config.workspaceDefaults)
  for (const notice of await migrateNode({ node: input.config, ...(input.platform ? { platform: input.platform } : {}), ...(input.askName ? { askName: input.askName } : {}) })) logger.warn(notice)
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
  /** Whether records of a workspace by this id are still on disk, from one removed without --purge (Q7). */
  const leftover = (id: string) => existsSync(join(node.stateDirectory, 'workspaces', id))
  /** The marker a removal leaves beside the kept records: the folder, its name, and when (addendum to D85, Q15). */
  const removedMarker = (id: string) => join(node.stateDirectory, 'workspaces', id, 'removed.json')

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
     * and never again. Its id is derived from the folder (D85, Q15, workspaceIdFor), so a removed workspace's grants and
     * settings, which stay on disk (Q7), are taken up again when the folder is registered again, as the answer says,
     * with whether its dangerously-allow switch is on. Its name is `name`, else the folder's, unique on the node. Its
     * settings are the defaults, the folder at /workspace, with `policy` and `settings` over them; naming either over
     * records taken up is refused, as they would be dropped (finding 36 of the Phase 1 review).
     */
    async create(value: WorkspaceRegistration & { label?: string; settings?: (defaults: WorkspaceSettings) => WorkspaceSettings }): Promise<{ workspace: WorkspaceDescriptor; token: MintedToken; takenUp: TakenUp | null }> {
      const given = value.name ?? value.id
      const chosen = given === undefined ? undefined : checkedName(given, 'given')
      const dir = canonicalDirectory(value.dir, platform)
      assertNoHostExposure(dir, exposed, platform)
      const minted: MintedToken = { id: 'initial', token: mintToken(), label: value.label ?? 'Registered', createdAt: new Date().toISOString() }
      /** The settings this call wrote, taken away again where the registration then fails, so no record is left for a later take-up to claim. */
      let wrote: string | null = null
      const created = await store.update(async (state) => {
        if ([stateRoot, ...state.workspaces.map(workspace => workspace.dir)].some(existing => overlaps(existing, dir, platform))) {
          throw new WorkspaceError('A workspace folder must not hold, or sit inside, another workspace or Buckle state', 409)
        }
        // A folder's id is derived from it, so re-registering takes up its removed records; --fresh starts a new id and leaves them (addendum to D85, Q15).
        const id = value.fresh === true ? randomUUID() : workspaceIdFor(dir)
        if (state.workspaces.some(workspace => workspace.id === id)) throw new WorkspaceError('This folder is a workspace already', 409)
        // Every check on the name comes before the first write (fix brief 4, findings 2, 19, and 41).
        const name = chosen ?? checkedName(basename(dir), 'folder')
        if (nameTaken(state, name)) throw new WorkspaceNameTakenError(name)
        const takenUp = leftover(id) ? { dangerouslyAllow: switchKeys(dangerouslyAllowPath({ stateDirectory: join(node.stateDirectory, 'workspaces', id) })).includes(id) } : null
        if (takenUp && (value.policy || value.settings)) {
          throw new WorkspaceError(`This folder's records from before it was removed stay in the state directory, and registering it takes them up, its settings among them, in place of the policy or settings named here. Register it without them, delete them with buckle workspace remove ${name} --purge, then register it again with them`, 409)
        }
        if (!existsSync(settingsPath(node.stateDirectory, id))) {
          // The folder shows at /workspace (D84 (3)); a policy names lists alone, and every other setting is the node's.
          const defaults = value.policy ? withPolicy(defaultSettings(), value.policy) : defaultSettings()
          wrote = existsSync(join(node.stateDirectory, 'workspaces', id)) ? settingsPath(node.stateDirectory, id) : join(node.stateDirectory, 'workspaces', id)
          await settingsOf(id).update(() => (value.settings ? value.settings(defaults) : defaults))
        }
        const workspace: StoredWorkspace = { id, name, dir, online: true, revision: 0, updatedAt: minted.createdAt, createdAt: minted.createdAt,
          tokens: [{ id: minted.id, sha256: tokenDigest(minted.token), label: minted.label, createdAt: minted.createdAt }] }
        state.workspaces.push(workspace)
        // The records are an active workspace's again: the removal marker goes, so prune no longer lists them.
        if (takenUp) rmSync(removedMarker(id), { force: true })
        nodeRoots.take(state.workspaces.map(item => item.dir))
        return { workspace: describe(workspace), takenUp }
      }).catch((error: unknown) => {
        if (wrote !== null) rmSync(wrote, { recursive: true, force: true })
        throw error
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
    authenticateWorkbench(id: string, workbenchId: string, authorization: string | undefined): string | null {
      const token = workbenchGrant(authorization)
      if (!token) return null
      // A path that names no workspace (NODE_SCOPE) is served by the node's own folder's workspace, as 0.1 served the node folder (D85, Q15).
      const target = id === NODE_SCOPE ? store.read().workspaces.find(item => item.nodeFolder)?.id : id
      if (target === undefined) return null
      const directory = workbenchesOf(target)
      return directory !== null && storedGrantMatches({ directory, workbenchId, token }) ? target : null
    },

    /**
     * Renames a workspace or sets it online or offline (D83 addendum (5)); going offline waits for its active work, and
     * then closes the runtime this process holds for it, whether the check opened it or it was open before (fix brief
     * 2, R1), so its browser, terminals, and language servers end with the change; `buckle serve` closes what other
     * processes took offline at its next look at the registry (closeUnserved).
     */
    async update(id: string, patch: z.infer<typeof WorkspacePatchSchema>): Promise<WorkspaceDescriptor> {
      const renamed = patch.name === undefined ? undefined : checkedName(patch.name, 'given')
      const checked = patch.online === false ? await assertIdle(id, { refusal: 'Resolve active tools and staged work before taking this workspace offline', deletes: false }) : null
      const opened = await openedRuntime(id)
      const pending = runtimes.get(id)
      let described: WorkspaceDescriptor
      try {
        described = await store.update((state) => {
          const workspace = requireStored(state, id)
          if (patch.expectedUpdatedAt !== undefined && workspace.updatedAt !== patch.expectedUpdatedAt) throw new WorkspaceError('Workspace changed; reload before saving', 409)
          if (renamed !== undefined && nameTaken(state, renamed, id)) throw new WorkspaceNameTakenError(renamed)
          if (renamed !== undefined) workspace.name = renamed
          if (patch.online !== undefined) workspace.online = patch.online
          touched(workspace)
          return describe(workspace)
        })
      } catch (error) {
        // The change was refused: a runtime opened for the check alone has nothing to stay open for.
        if (checked?.openedForCheck && opened && pending) await drop(id, pending, opened)
        throw error
      }
      if (opened && pending) {
        opened.config.serverName = described.name
        // An offline workspace serves no call: its runtime closes, and its log no longer holds the node's readiness (review L5 of B20-B22).
        if (!described.online) await dropUnlessBusy(id, pending, opened, 'taken offline')
      }
      return described
    },

    /**
     * Removes the registration alone, as removing an MCP server removes its config (D83 addendum (6), Q7): the folder is
     * never touched, and the workspace's records (settings, grants, history, audit) stay unless `purge` deletes them;
     * the folder registered again takes them up (create).
     */
    async remove(id: string, options: { purge?: boolean } = {}): Promise<WorkspaceDescriptor> {
      await assertIdle(id, { refusal: 'Resolve active tools and staged work before removing this workspace', deletes: options.purge === true })
      const opened = await openedRuntime(id)
      const removed = await store.update((state) => {
        const workspace = requireStored(state, id)
        state.workspaces = state.workspaces.filter(item => item.id !== id)
        nodeRoots.take(state.workspaces.map(item => item.dir))
        return describe(workspace)
      })
      const pending = runtimes.get(id)
      const stays = opened && pending ? !await dropUnlessBusy(id, pending, opened, 'removed') : false
      if (options.purge && stays) {
        // A call began while the registry changed: its records are not deleted under it. They are marked as any removal's are, and prune deletes them.
        writeRemovedMarker(id, removed)
        throw new WorkspaceError(`Workspace ${removed.name} is removed, but a call began in it meanwhile, so its records are kept; run buckle workspace prune once the call ends to delete them`, 409)
      }
      if (options.purge) rmSync(join(node.stateDirectory, 'workspaces', id), { recursive: true, force: true })
      // Its records stay, with a marker naming the folder, so `buckle workspace add` can take them up and `buckle workspace prune` can find them.
      else if (existsSync(join(node.stateDirectory, 'workspaces', id))) writeRemovedMarker(id, removed)
      return removed
    },

    /**
     * The removed workspaces whose records still sit in the state directory (addendum to D85, Q15): each folder that
     * left a removal marker and holds no current registration. With `yes`, deletes those records. Never touches a
     * folder, nor the records of a registered workspace.
     */
    prune(options: { yes?: boolean } = {}): RemovedWorkspace[] {
      const base = join(node.stateDirectory, 'workspaces')
      if (!existsSync(base)) return []
      const registered = new Set(store.read().workspaces.map(workspace => workspace.id))
      const removed: RemovedWorkspace[] = []
      for (const id of readdirSync(base)) {
        if (registered.has(id) || !existsSync(removedMarker(id))) continue
        try {
          const marker = JSON.parse(readFileSync(removedMarker(id), 'utf8')) as { dir?: string; name?: string; removedAt?: string }
          removed.push({ id, dir: marker.dir ?? '', name: marker.name ?? id, removedAt: marker.removedAt ?? '' })
        } catch { removed.push({ id, dir: '', name: id, removedAt: '' }) }
      }
      if (options.yes) for (const entry of removed) rmSync(join(base, entry.id), { recursive: true, force: true })
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
      // Every registered folder is held to the host exposure; the node's own folder is not, as 0.1 did not hold it (D85, Q15, StoredWorkspaceSchema.nodeFolder).
      if (!workspace.nodeFolder) assertNoHostExposure(workspace.dir, exposed, platform)
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
          const config = workspaceConfig(node, { id, name: workspace.name, nodeFolder: workspace.nodeFolder === true, dir, ...scopeOf(settings, node.workspaceDefaults) })
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
     * has no active work, so a removed workspace's browser, terminals, and language servers end with it. A workbench
     * lock another process holds is not work, and a runtime that will not close is logged, not allowed to keep the
     * others open. `buckle serve` calls it at each look at the registry (finding 2; fix brief 4, finding 28).
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
        // One that will not close is logged, and the rest still close.
        try {
          const opened = await pending.catch(() => null)
          if (opened && !await earlierHasWork(opened.runtime)) await drop(id, pending, opened)
        } catch (error) { logger.error('Could not close a workspace this process no longer serves', { workspaceId: id, error }) }
      }
    },

    /** The workspace a handle names (D85, Q15): its id, or its name compared without regard to case; null where none does. */
    lookup(handle: string): WorkspaceDescriptor | null {
      const found = lookupStored(store.read(), handle)
      return found ? describe(found) : null
    },

    /**
     * The workspace a command means (D83 (4)): `workspace` by name or id, else the one whose folder holds `dir`, else
     * the one whose folder holds `cwd`. Refused with the names, never a folder, where none does.
     */
    target(where: { workspace?: string; dir?: string; cwd: string }): string {
      const state = store.read()
      if (where.workspace !== undefined) {
        const found = lookupStored(state, where.workspace)
        if (!found) throw new WorkspaceError(`No workspace is named ${where.workspace}${state.workspaces.length === 0 ? ', and this node has none yet: run buckle init, or buckle workspace init in the folder to serve' : `. The workspaces: ${names(state)}`}`, 404)
        return found.id
      }
      const holding = holderOf(state, where.dir === undefined ? where.cwd : resolve(where.cwd, where.dir), platform)
      if (holding) return holding.id
      const named = where.dir === undefined ? 'the current directory' : 'that directory'
      throw new WorkspaceError(state.workspaces.length === 0
        ? `No workspace holds ${named}, and this node has none yet: run buckle init, or buckle workspace init in the folder to serve`
        : `No workspace holds ${named}. Name one with --workspace <name> (${names(state)}), or run buckle workspace init in the folder to serve`, 404)
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
   * until it opens and shows none. Answers whether the check opened the runtime, which the refusal closes again (fix
   * brief 2, R1): the change was refused, so nothing stays open for it.
   */
  async function assertIdle(id: string, input: { refusal: string; deletes: boolean }): Promise<{ openedForCheck: boolean }> {
    requireStored(store.read(), id)
    if (activeElsewhere({ directory: activeWorkDirectory(node.stateDirectory, id) })) throw new WorkspaceError(input.refusal, 409)
    let opened = await openedRuntime(id)
    const openedForCheck = opened === null
    if (!opened) {
      try { opened = await manager.resolve(id, { setup: true }) } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        if (input.deletes) throw new WorkspaceError(`Workspace ${id} will not open, so its staged work cannot be checked before its records are deleted: ${reason}. Remove it without --purge, or repair it first`, 409)
        logger.warn('A workspace would not open to check its staged work; nothing of it is deleted, so the change goes ahead', { workspaceId: id, error })
        return { openedForCheck: false }
      }
    }
    if (await holdsWork(opened.runtime)) {
      const pending = runtimes.get(id)
      if (openedForCheck && pending) await drop(id, pending, opened)
      throw new WorkspaceError(input.refusal, 409)
    }
    return { openedForCheck }
  }

  function writeRemovedMarker(id: string, removed: WorkspaceDescriptor): void {
    writeFileSync(removedMarker(id), `${JSON.stringify({ version: 1, dir: removed.dir, name: removed.name, removedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
  }

  /**
   * Drops a runtime once the registry no longer serves its workspace, unless a call began in it since the check that
   * allowed the change: that call runs to its end on the runtime, which stays for closeUnserved to close once it has
   * no work, and the log says so. Answers whether it was dropped.
   */
  async function dropUnlessBusy(id: string, pending: Promise<ManagedWorkspace>, opened: ManagedWorkspace, change: string): Promise<boolean> {
    if (await holdsWork(opened.runtime)) {
      logger.warn(`A call began in a workspace while it was ${change}; its runtime stays open until the call ends, then closes`, { workspaceId: id })
      return false
    }
    await drop(id, pending, opened)
    return true
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
    const config = workspaceConfig(node, { id, name: workspace.name, nodeFolder: workspace.nodeFolder === true, dir: workspace.dir, ...scopeOf(defaultSettings(), node.workspaceDefaults) })
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

/** The workspace `handle` names: by id first, then by name without regard to case (D85, Q15). */
function lookupStored(state: Registry, handle: string): StoredWorkspace | undefined {
  return state.workspaces.find(item => item.id === handle) ?? state.workspaces.find(item => sameName(item.name, handle))
}

/** Whether another workspace than `exceptId` holds `name`, compared without regard to case. */
function nameTaken(state: Registry, name: string, exceptId?: string): boolean {
  return state.workspaces.some(item => item.id !== exceptId && sameName(item.name, name))
}

/** The name as the registry will hold it, trimmed, or the refusal, before anything is written (fix brief 4, findings 2 and 19). */
function checkedName(raw: string, source: 'folder' | 'given'): string {
  const parsed = WorkspaceNameSchema.safeParse(raw)
  if (!parsed.success) throw new WorkspaceNameRefusedError(raw, parsed.error.issues.map(issue => issue.message).join('; '), source)
  return parsed.data
}

/** The workspaces' names as a refusal lists them, so the owner can name one. */
function names(state: Registry): string {
  return state.workspaces.map(workspace => workspace.name).join(', ')
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

/**
 * Whether a workspace's runtime has work. Another process's calls are signalled by its active-work mark alone, read
 * before this (assertIdle); a workbench lock that process holds is not evidence of work (recheck of findings 5 and 9 of the Phase 1 review), since
 * `buckle serve` keeps it from its first look at the workbenches until it stops. So the workbench records are read
 * from disk without the lock as well as this process's own work: an open workbench counts whoever holds it, a closed
 * one does not.
 */
async function holdsWork(runtime: BuckleRuntime): Promise<boolean> {
  return await runtime.hasActiveWork() || runtime.inspectActiveWork()
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
  runtime.closeWatchers()
  await runtime.approvalService.close()
  await runtime.cancelInvocations()
  await runtime.workbenches.stopTerminals()
  await runtime.closeSessions()
  await runtime.workbenches.close()
  await runtime.history.close()
}
