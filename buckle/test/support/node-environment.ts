import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A node's environment for the HTTP harness under a fresh temporary root: a workspace directory and
 * an owner-only state directory, as startup requires (ruling 7). A gated call over HTTP is held for
 * BUCKLE_APPROVAL_TIMEOUT_MS as in production; 1 ms here answers approval_required at once (0 would wait until answered).
 */
export function nodeEnvironment(prefix: string, extra: Record<string, string> = {}): { root: string; workspace: string; state: string; environment: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const workspace = join(root, 'workspace')
  const state = join(root, 'state')
  mkdirSync(workspace)
  mkdirSync(state, { mode: 0o700 })
  return { root, workspace, state, environment: { BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: state, BUCKLE_ALLOW_SHELL: 'false', BUCKLE_APPROVAL_TIMEOUT_MS: '1', ...extra } }
}
