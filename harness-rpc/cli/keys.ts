import { parseArgs } from 'node:util'
import { ClientKeyError, createFileClientKeys, describeScope } from '../common/adapters/keys/file-client-keys.js'
import { loadNodeKey } from '../common/adapters/keys/file-node-key.js'
import { clientKeysPath, nodeKeyPath, setupSessionsPath, type BuckleConfig } from '../common/runtime/config.js'
import { createSetupSessions } from '../common/services/access/setup-sessions.js'
import { NODE_SCOPE, type KeyPurpose } from '../common/types/ports/client-keys.js'

export interface CliResult {
  exitCode: number
  /** For the audit entry: the verb and the key's fingerprint, never the key. */
  detail?: string
}

const USAGE = `Usage:
  buckle keys enroll <public-key> --purpose setup|approval|both --workspace <id>|node [--label <text>]
                                                     Trust a person's client key for signed setup changes,
                                                     approval decisions or both, on one workspace or the
                                                     whole node (the registry needs node)
  buckle keys list [--json]                          The enrolled keys with their scope, revoked ones included
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
      const { values, positionals } = parseArgs({ args: rest, options: { label: { type: 'string' }, purpose: { type: 'string' }, workspace: { type: 'string' } }, allowPositionals: true })
      if (positionals.length !== 1) return fail(USAGE)
      const scope = enrollScope(values)
      if (typeof scope === 'string') return fail(scope)
      const enrolled = await keys.enroll({ publicKey: positionals[0]!, label: values.label ?? '', ...scope })
      process.stdout.write(`Enrolled ${enrolled.keyId}${enrolled.label ? ` (${enrolled.label})` : ''} for ${describeScope(enrolled)}.\nCheck this fingerprint against the one \`buckle client key\` prints on the person's own device before relying on it.\n`)
      return { exitCode: 0, detail: `enroll ${enrolled.keyId} ${enrolled.purpose} ${enrolled.workspace}` }
    }
    if (verb === undefined || verb === 'list') {
      const { values } = parseArgs({ args: rest, options: { json: { type: 'boolean' } }, allowPositionals: false })
      const listed = keys.list()
      if (values.json) process.stdout.write(`${JSON.stringify(listed, null, 2)}\n`)
      else if (listed.length === 0) process.stdout.write('No client keys are enrolled.\n')
      else for (const key of listed) process.stdout.write(`${key.keyId}  ${describeScope(key)}  ${key.revokedAt ? `revoked ${key.revokedAt}` : `enrolled ${key.enrolledAt}`}${key.label ? `  ${key.label}` : ''}\n`)
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
      process.stdout.write(`Node:        ${input.config.serverId}\nPublic key:  ${node.publicKey}\nFingerprint: ${node.keyId}\nOn a person's device: buckle client trust <this node's URL> ${input.config.serverId} ${node.publicKey}\n`)
      return { exitCode: 0 }
    }
  } catch (error) {
    if (error instanceof ClientKeyError) return fail(error.message)
    throw error
  }
  return fail(USAGE)
}

const WORKSPACE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/** The scope an enrollment names, both parts required (owner decision D10), or why it cannot be used. */
function enrollScope(values: { purpose?: string; workspace?: string }): { purpose: KeyPurpose; workspace: string } | string {
  const { purpose, workspace } = values
  if (purpose !== 'setup' && purpose !== 'approval' && purpose !== 'both') return `--purpose takes setup, approval or both: what this key may sign\n${USAGE}`
  if (workspace === undefined || (workspace !== NODE_SCOPE && !WORKSPACE_ID.test(workspace))) return `--workspace takes a workspace id, or node for every workspace and the registry\n${USAGE}`
  return { purpose, workspace }
}

function fail(message: string): CliResult {
  process.stderr.write(`${message}\n`)
  return { exitCode: 1 }
}
