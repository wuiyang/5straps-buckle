import { legacyWorkspaceRoot, loadConfig, NODE_FOLDER_WORKSPACE, workspaceConfig, type BuckleConfig } from '../../common/runtime/config.js'
import { scopeOf, settingsFromEnvironment } from '../../common/services/workspaces/workspace-settings.js'

/**
 * The configuration a workspace's runtime receives, from an environment that describes the workspace the way a node
 * set up before the workspace model did (the workspace-model brief, item 8): the node's settings, the folder in
 * BUCKLE_WORKSPACE_ROOT or the working directory, and the workspace's own settings as migration reads them. One seam,
 * so the tests that build a runtime from an environment move once.
 */
export function configFromEnvironment(environment: NodeJS.ProcessEnv = {}, platform: NodeJS.Platform = process.platform): BuckleConfig {
  const node = loadConfig(environment, platform)
  return workspaceConfig(node, { id: NODE_FOLDER_WORKSPACE, name: node.serverName, dir: legacyWorkspaceRoot({ node, platform }), ...scopeOf(settingsFromEnvironment(environment, platform)) })
}
