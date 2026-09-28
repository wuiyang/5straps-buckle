import { parseArgs } from 'node:util'
import { ClientKeyError, createFileClientKeys } from '../common/adapters/keys/file-client-keys.js'
import { clientKeysPath, type BuckleConfig } from '../common/runtime/config.js'

export interface CliResult {
  exitCode: number
  /** For the audit entry: the verb and the key's fingerprint, never the key. */
  detail?: string
}

const USAGE = `Usage:
  buckle keys enroll <public-key> [--label <text>]   Trust a person's client key for signed setup and approvals
  buckle keys list [--json]                          The enrolled keys, revoked ones included
  buckle keys revoke <key-id>                        Stop trusting a key, at once`

/**
 * The node's trusted client keys (owner ruling H4 of 2026-09-28): the SSH model, where a person's
 * client keeps its private key and the owner enrolls the public half here. Local only: no HTTP route
 * enrolls, lists or revokes a key.
 */
export async function keysCommand(input: { config: BuckleConfig; argv: string[] }): Promise<CliResult> {
  const keys = createFileClientKeys({ filePath: clientKeysPath(input.config), lockDeadlineMs: input.config.stateLockDeadlineMs })
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
      process.stdout.write(`Revoked ${keyId}: requests it signs are refused from now on.\n`)
      return { exitCode: 0, detail: `revoke ${keyId}` }
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
