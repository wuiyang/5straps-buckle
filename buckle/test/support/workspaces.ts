import type { WorkspacePolicy } from '@5straps/protocol'
import type { BuckleConfig, NodeConfig } from '../../common/runtime/config.js'
import { nodeConfigOf } from './workspace-config.js'
import { openWorkspaceManager, type ManagedWorkspace, type WorkspaceManager } from '../../common/services/workspaces/workspace-manager.js'
import type { InteractionSource } from '../../common/services/approvals/interaction.js'
import type { BuckleCommon } from '../../common/runtime/initialize.js'
import type { BuckleRuntime } from '../../common/services/workspaces/workspace-runtime.js'
import { realpathSync } from 'node:fs'
import { nativePath } from '../../common/domain/paths.js'
import { openRegistry } from '../../common/services/workspaces/registry.js'
import { workspaceIdFor } from '../../common/services/workspaces/workspace-id.js'
import { tokenDigest } from '../../common/services/access/tokens.js'

/** A node's workspaces as its first command opens them: a node described the 0.1 way migrates, its folder a workspace named after it. */
export function workspacesOf(config: NodeConfig & Partial<Pick<BuckleConfig, 'nodeStateDirectory'>>, options: { interaction?: InteractionSource; platform?: NodeJS.Platform } = {}): Promise<WorkspaceManager> {
  return openWorkspaceManager({ config: nodeConfigOf(config), ...options })
}

/** Registers a folder as `buckle workspace init` does, named `id` (ids are assigned, D85, Q15), with `policy` as its policy, and answers the token it was given. */
export async function registerWorkspace(manager: WorkspaceManager, input: { id: string; dir: string; name?: string; policy?: WorkspacePolicy }): Promise<string> {
  const { token } = await manager.create({ dir: input.dir, name: input.name ?? input.id, ...(input.policy ? { policy: input.policy } : {}) })
  return token.token
}

/** The workspace named `name`, opened: what `--workspace <name>` resolves (D85, Q15). */
export function byName(manager: WorkspaceManager, name: string, options: { setup?: boolean } = {}): Promise<ManagedWorkspace> {
  return manager.resolve(manager.target({ workspace: name, cwd: '/' }), options)
}

/** The id a folder's workspace has, as the registry derives it from the folder as the disk names it (D85, Q15). */
export function workspaceIdOf(dir: string): string {
  return workspaceIdFor(nativePath(realpathSync.native(dir)))
}

/** The id of the workspace named `name`. */
export function idOf(manager: WorkspaceManager, name: string): string {
  return manager.target({ workspace: name, cwd: '/' })
}

/** The node folder's workspace's runtime on a started node: the folder its environment named, as migration made it, listed first. */
export async function defaultRuntime(common: BuckleCommon): Promise<BuckleRuntime> {
  const workspaces = await common.services.getWorkspaces()
  return (await workspaces.resolve(workspaces.list()[0]!.id)).runtime
}

/**
 * Gives a registered workspace one more agent token of the test's choosing, stored by its digest as Buckle stores every
 * token, for a fixture table written before the workspace exists. Buckle itself only mints them (D83 (3)).
 */
export async function holdToken(stateDirectory: string, workspaceId: string, token: string): Promise<void> {
  await openRegistry({ stateDirectory }).update((state) => {
    const workspace = state.workspaces.find(item => item.id === workspaceId)
    if (!workspace) throw new Error(`No workspace ${workspaceId} to hold the token`)
    workspace.tokens.push({ id: `fixture-${workspace.tokens.length}`, sha256: tokenDigest(token), label: 'test fixture', createdAt: new Date().toISOString() })
  })
}
