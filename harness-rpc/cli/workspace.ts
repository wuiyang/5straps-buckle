import { randomBytes } from 'node:crypto'
import { parseArgs } from 'node:util'
import type { BuckleConfig } from '../common/runtime/config.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { createWorkspaceManager, WorkspaceError, WorkspaceRegistrationSchema } from '../common/services/workspaces/workspace-manager.js'

export interface CliResult {
  exitCode: number
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
export function workspaceRegistryCommand(input: { config: BuckleConfig; runtime: BuckleRuntime; argv: string[] }): CliResult {
  const [verb = 'list', ...rest] = input.argv
  if (!input.config.adminToken) {
    return fail('This node has no admin credential. Set BUCKLE_ADMIN_TOKEN, or run buckle init, before minting workspace credentials.')
  }
  const manager = createWorkspaceManager({ config: input.config, runtime: input.runtime })

  try {
    if (verb === 'list') return print(manager.list())
    if (verb === 'add') return addWorkspace(manager, rest)
    if (verb === 'token') return tokenCommand(manager, rest)
  } catch (error) {
    if (error instanceof WorkspaceError) return fail(error.message)
    throw error
  }
  return fail(USAGE)
}

function addWorkspace(manager: ReturnType<typeof createWorkspaceManager>, argv: string[]): CliResult {
  const { positionals, values } = parseArgs({ args: argv, options: { root: { type: 'string' }, name: { type: 'string' } }, allowPositionals: true })
  const id = positionals[0]
  if (!id || !values.root) return fail('Usage: buckle workspace add <id> --root <dir> [--name <name>]')

  const authToken = credential()
  const adminToken = credential()
  const parsed = WorkspaceRegistrationSchema.safeParse({ id, name: values.name ?? id, root: values.root, authToken, adminToken })
  if (!parsed.success) return fail(`Invalid workspace: ${parsed.error.issues.map(issue => issue.message).join('; ')}`)

  const workspace = manager.register(parsed.data)
  process.stdout.write(`Registered workspace ${workspace.id} at ${workspace.root}

  agent token        ${authToken}
  admin credential   ${adminToken}

Both are shown once. The agent token calls tools under /workspaces/${workspace.id}/v1; the
admin credential opens /workspaces/${workspace.id}/setup and mints further tokens with
buckle workspace token add ${workspace.id}.
`)
  return { exitCode: 0 }
}

function tokenCommand(manager: ReturnType<typeof createWorkspaceManager>, argv: string[]): CliResult {
  const [action, workspaceId, tokenId] = argv
  if (!action || !workspaceId) return fail(USAGE)

  if (action === 'list') return print(manager.listTokens(workspaceId))
  if (action === 'add') {
    const { values } = parseArgs({ args: argv.slice(2), options: { label: { type: 'string' } }, allowPositionals: false })
    const minted = manager.addToken(workspaceId, { label: values.label })
    process.stdout.write(`Minted ${minted.id} for workspace ${workspaceId}

  agent token   ${minted.token}

Shown once. Revoke it with buckle workspace token revoke ${workspaceId} ${minted.id}.
`)
    return { exitCode: 0 }
  }
  if (action === 'revoke') {
    if (!tokenId) return fail(`Usage: buckle workspace token revoke ${workspaceId} <token-id>`)
    if (!manager.revokeToken(workspaceId, tokenId)) return fail(`Workspace token not found: ${tokenId}`)
    process.stdout.write(`Revoked ${tokenId}. Calls presenting it are refused from now on.\n`)
    return { exitCode: 0 }
  }
  return fail(USAGE)
}

function credential(): string {
  return randomBytes(24).toString('base64url')
}

function print(value: unknown): CliResult {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  return { exitCode: 0 }
}

function fail(message: string): CliResult {
  process.stderr.write(`${message}\n`)
  return { exitCode: 1 }
}
