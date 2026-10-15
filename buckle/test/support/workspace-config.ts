import { basename } from 'pathe'
import { legacyWorkspaceRoot, loadConfig, workspaceConfig, type BuckleConfig, type NodeConfig } from '../../common/runtime/config.js'
import { workspaceIdFor } from '../../common/services/workspaces/workspace-id.js'
import { scopeOf, WorkspaceSettingsSchema } from '../../common/services/workspaces/workspace-settings.js'

/**
 * The configuration a workspace's runtime receives, from an environment that describes the workspace the way a node
 * set up before the workspace model did (the workspace-model brief, item 8): the node's settings, the folder in
 * BUCKLE_WORKSPACE_ROOT or the working directory, and a workspace that sets nothing of its own, so the node's settings
 * in the environment are its own in force (D85, Q3). One seam, so the tests that build a runtime from an environment
 * move once.
 */
/**
 * The node's own configuration behind a workspace's: its state directory is the node's, where the registry and every
 * workspace's records live, not the workspace's own (D85, Q15). What a test hands the entry points that take the node.
 */
export function nodeConfigOf(config: NodeConfig & Partial<Pick<BuckleConfig, 'nodeStateDirectory'>>): NodeConfig {
  return { ...config, stateDirectory: config.nodeStateDirectory ?? config.stateDirectory }
}

export function configFromEnvironment(environment: NodeJS.ProcessEnv = {}, platform: NodeJS.Platform = process.platform): BuckleConfig {
  const node = loadConfig(environment, platform)
  const dir = legacyWorkspaceRoot({ node, platform })
  // Named and keyed after its folder, as migration names and keys the node's folder (D85, Q15), so a manager over the same state directory finds the same workspace.
  return workspaceConfig(node, { id: workspaceIdFor(dir), name: basename(dir), dir, ...scopeOf(WorkspaceSettingsSchema.parse({ version: 1 }), node.workspaceDefaults) })
}
