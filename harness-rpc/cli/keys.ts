import { parseArgs } from 'node:util'
import { ClientKeyError, createFileClientKeys } from '../common/adapters/keys/file-client-keys.js'
import { loadNodeKey } from '../common/adapters/keys/file-node-key.js'
import { clientKeysPath, nodeKeyPath, setupSessionsPath, type BuckleConfig } from '../common/runtime/config.js'
import { createSetupSessions } from '../common/services/access/setup-sessions.js'

export interface CliResult {
  exitCode: number
  /** For the audit entry: the verb and the key's fingerprint, never the key. */
  detail?: string
}

const USAGE = `Usage:
  buckle keys enroll <public-key> [--label <text>]   Trust a person's client key for signed setup and approvals
  buckle keys list [--json]                          The enrolled keys, revoked ones included
  buckle keys revoke <key-id>                        Stop trusting a key, at once, and close its setup sessions
  buckle keys sessions                               The setup sessions keys hold open
  buckle keys node                                   This node's own public key, for a person's client to pin`

/**
 * The node's trusted client keys (owner ruling H4 of 2026-09-28): the SSH model, where a person's
 * client keeps its private key and the owner enrolls the public half here. Local only: no HTTP route
 * enrolls, lists or revokes a key.
 */
export async function keysCommand(input: { config: BuckleConfig; argv: string[] }): Promise<CliResult> {
  const keys = createFileClientKeys({ filePath: clientKeysPath(input.config), lockDeadlineMs: input.config.stateLockDeadlineMs })
  const sessions = () => createSetupSessions({ filePath: setupSessionsPath(input.config), lockDeadlineMs: input.config.stateLockDeadlineMs })
  const [verb, ...rest] = input.argv
  try {
    if (verb === 'enroll') {
      const { values, positionals } = parseArgs({ args: rest, options: { label: { type: 'string' } }, allowPositionals: true })
      if (positionals.length !== 1) return fail(USAGE)
      const enrolled = await keys.enroll({ publicKey: positionals[0]!, label: values.label ?? '' })
      process.stdout.write(`Enrolled ${enrolled.keyId}${enrolled.label ? ` (${enrolled.label})` : ''}.\nCheck this fingerprint against the one \`buckle client key\` prints on the person's own device before relying on it.\n`)
      return { exitCode: 0, detail: `enroll ${enrolled.keyId}` }
    }
    if (verb === undefined || verb === 'list') {
      const { values } = parseArgs({ args: rest, options: { json: { type: 'boolean' } }, allowPositionals: false })
      const listed = keys.list()
      if (values.json) process.stdout.write(`${JSON.stringify(listed, null, 2)}\n`)
      else if (listed.length === 0) process.stdout.write('No client keys are enrolled.\n')
      else for (const key of listed) process.stdout.write(`${key.keyId}  ${key.revokedAt ? `revoked ${key.revokedAt}` : `enrolled ${key.enrolledAt}`}${key.label ? `  ${key.label}` : ''}\n`)
      return { exitCode: 0 }
    }
    if (verb === 'revoke') {
      const [keyId] = rest
      if (!keyId || rest.length !== 1) return fail(USAGE)
      if (!await keys.revoke(keyId)) return fail(`No enrolled key has the id ${keyId}; buckle keys list shows them`)
      const closed = await sessions().closeForKey(keyId)
      process.stdout.write(`Revoked ${keyId}: requests it signs are refused from now on${closed ? `, and its ${closed} open setup session${closed === 1 ? '' : 's'} closed` : ''}.\n`)
      return { exitCode: 0, detail: `revoke ${keyId}` }
    }
    if (verb === 'sessions') {
      const open = sessions().list()
      if (open.length === 0) process.stdout.write('No setup session is open.\n')
      for (const session of open) process.stdout.write(`${session.id}  workspace ${session.workspaceId}  ${session.keyId}  last active ${session.lastActivityAt}, closes ${session.idleExpiresAt} if idle\n`)
      return { exitCode: 0 }
    }
    if (verb === 'node') {
      const node = loadNodeKey(nodeKeyPath(input.config))
      process.stdout.write(`Node:        ${input.config.serverId}\nPublic key:  ${node.publicKey}\nFingerprint: ${node.keyId}\nOn a person's device: buckle client trust ${input.config.serverId} ${node.publicKey}\n`)
      return { exitCode: 0 }
    }
  } catch (error) {
    if (error instanceof ClientKeyError) return fail(error.message)
    throw error
  }
  return fail(USAGE)
}

function fail(message: string): CliResult {
  process.stderr.write(`${message}\n`)
  return { exitCode: 1 }
}
