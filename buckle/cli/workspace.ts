import { parseArgs } from 'node:util'
import type { NodeConfig } from '../common/runtime/config.js'
import { WorkspaceError, type WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'

export interface CliResult {
  exitCode: number
  /** For the audit entry: what changed, never a token. */
  detail?: string
}

const USAGE = `Usage:
  buckle workspace list
  buckle workspace add <id> --root <dir> [--name <name>]
  buckle workspace token list <workspace>
  buckle workspace token add <workspace> [--label <text>]
  buckle workspace token revoke <workspace> <token-id>`

/**
 * The owner's registry commands. `BUCKLE-D12` names the admin credential as the one authority
 * that mints or revokes a workspace token, so every verb here refuses on a node configured
 * without one, and `SELF_ADMINISTRATION` in the command policy keeps a tool from reaching them.
 */
export async function workspaceRegistryCommand(input: { config: NodeConfig; workspaces: WorkspaceManager; argv: string[] }): Promise<CliResult> {
  const [verb = 'list', ...rest] = input.argv
  if (!input.config.adminToken) {
    return fail('This node has no admin credential. Set BUCKLE_ADMIN_TOKEN, or run buckle init, before minting workspace credentials.')
  }
  const manager = input.workspaces

  try {
    if (verb === 'list') return print(manager.list())
    if (verb === 'add') return await addWorkspace(manager, rest)
    if (verb === 'token') return await tokenCommand(manager, rest)
  } catch (error) {
    if (error instanceof WorkspaceError) return fail(error.message)
    throw error
  }
  return fail(USAGE)
}

async function addWorkspace(manager: WorkspaceManager, argv: string[]): Promise<CliResult> {
  const { positionals, values } = parseArgs({ args: argv, options: { root: { type: 'string' }, name: { type: 'string' } }, allowPositionals: true })
  const id = positionals[0]
  if (!id || !values.root) return fail('Usage: buckle workspace add <id> --root <dir> [--name <name>]')
  const { workspace, token } = await manager.create({ id, dir: values.root, name: values.name ?? id })
  process.stdout.write(`Registered workspace ${workspace.id} at ${workspace.dir}

  agent token        ${token.token}

Shown once. The agent token calls tools at /mcp and /v1, and under /workspaces/${workspace.id}/; the
node's admin credential opens its setup face, and buckle workspace token add ${workspace.id} mints more.
`)
  return { exitCode: 0 }
}

async function tokenCommand(manager: WorkspaceManager, argv: string[]): Promise<CliResult> {
  const [action, workspaceId, tokenId] = argv
  if (!action || !workspaceId) return fail(USAGE)

  if (action === 'list') return print(manager.listTokens(workspaceId))
  if (action === 'add') {
    const { values } = parseArgs({ args: argv.slice(2), options: { label: { type: 'string' } }, allowPositionals: false })
    const minted = await manager.addToken(workspaceId, { label: values.label })
    process.stdout.write(`Minted ${minted.id} for workspace ${workspaceId}

  agent token   ${minted.token}

Shown once. Revoke it with buckle workspace token revoke ${workspaceId} ${minted.id}.
`)
    return { exitCode: 0 }
  }
  if (action === 'revoke') {
    if (!tokenId) return fail(`Usage: buckle workspace token revoke ${workspaceId} <token-id>`)
    if (!await manager.revokeToken(workspaceId, tokenId)) return fail(`Workspace token not found: ${tokenId}`)
    process.stdout.write(`Revoked ${tokenId}. Calls presenting it are refused from now on.\n`)
    return { exitCode: 0 }
  }
  return fail(USAGE)
}

function print(value: unknown): CliResult {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  return { exitCode: 0 }
}

function fail(message: string): CliResult {
  process.stderr.write(`${message}\n`)
  return { exitCode: 1 }
}
