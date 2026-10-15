import { parseEnv } from 'node:util'
import { APPROVAL_KEY_PATTERN } from '@5straps/protocol/envelope'
import { legacyWorkspaceRoot, loadConfig, NODE_FOLDER_WORKSPACE, workspaceConfig } from '../common/runtime/config.js'
import { logger } from '../common/runtime/log.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { scopeOf, settingsFromEnvironment } from '../common/services/workspaces/workspace-settings.js'
import { editEnvironmentVariable, type EnvironmentEdit, updateEnvironmentFile } from './environment-file.js'

/** Where Rings takes a node's action log and its pending approvals. */
const REPORT_PATH = '/api/v1/buckle-reports'
const APPROVALS_PATH = '/api/v1/buckle-approvals'
/**
 * A report credential Buckle accepts from Rings: one run of URL-safe and base64 characters. Rings
 * mints 64 hex characters; anything holding whitespace, a quote, `#` or a line break could change
 * how the environment file reads, so it is refused rather than written.
 */
const REPORT_CREDENTIAL = /^[A-Za-z0-9._~+/=-]{16,512}$/
const REPAIR = 'issue a new pairing code for this node in Rings and run buckle init --pair <code> --rings <Rings URL> again'

export interface PairingRequest {
  /** The code the owner read off Rings. Short-lived and single use, so argv is where it belongs. */
  code: string
  ringsUrl: string
  /** Where Rings will reach this node. The default only works when Rings runs on this host. */
  baseUrl: string
  /** The environment file just written or reused: the credentials never leave it in argv. */
  environmentFile: string
  environmentText: string
  /** Where the environment-file lock lives (~/.5straps/locks); the owner's home by default. */
  home?: string
}

export interface PairingResult {
  ok: boolean
  message: string
}

/**
 * `BUCKLE-D08: Onboarding is buckle init plus a pairing code`. The node registers itself: it
 * reports the manifest it would serve along with the credentials Rings will call it with, so
 * nothing is copied between two screens and Rings needs no route back here to finish. Re-pairing
 * a node that moved sends the same manifest from a new URL, which updates its record.
 */
export async function redeemPairingCode(input: PairingRequest): Promise<PairingResult> {
  const environment = { ...process.env, ...parseEnv(input.environmentText) }
  const node = loadConfig(environment)
  const config = workspaceConfig(node, { id: NODE_FOLDER_WORKSPACE, name: node.serverName, dir: legacyWorkspaceRoot({ node }), ...scopeOf(settingsFromEnvironment(environment)) })
  const runtime = await createRuntime({ config })

  const response = await fetch(new URL('/api/v1/harness-servers/pairing/redeem', input.ringsUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: input.code,
      name: config.serverName,
      baseUrl: input.baseUrl,
      authToken: config.authToken,
      adminToken: config.adminToken || undefined,
      manifest: runtime.manifest(),
      approvalEnvelope: 1,
    }),
  }).catch((error: unknown) => {
    logger.error('Pairing request failed', { message: error instanceof Error ? error.message : 'Unknown error' })
    return null
  })

  if (!response) return { ok: false, message: `Could not reach Rings at ${input.ringsUrl}. The node is configured in ${input.environmentFile}; pair it again once Rings is reachable.` }
  if (!response.ok) return { ok: false, message: `Rings refused the pairing code (HTTP ${response.status}): ${await errorText(response)}` }

  const body = await response.json().catch(() => null) as { server?: { id?: string; name?: string }; reportToken?: unknown; approvalKey?: unknown } | null
  const paired = `Paired with Rings as ${body?.server?.name ?? config.serverName} (${body?.server?.id ?? config.serverId}).`
  if (!body?.reportToken) {
    // A Rings built before per-node report credentials answers without one; its installation-wide
    // token stays configured by hand, so the node is paired either way.
    logger.warn('Rings did not mint a report credential for this node; set BUCKLE_REPORT_URL and BUCKLE_REPORT_TOKEN by hand to report the action log')
    return { ok: true, message: paired }
  }
  if (typeof body.reportToken !== 'string' || !REPORT_CREDENTIAL.test(body.reportToken)) {
    logger.error('Rings answered with a report credential Buckle does not accept')
    return { ok: false, message: `${paired}\nRings answered with a report credential Buckle does not accept (it must be 16 to 512 letters, digits or ._~+/=-), so nothing was written to ${input.environmentFile}. Check that the Rings URL is the one you meant, then pair again.` }
  }
  // A Rings built before RINGS-D20 mints no key; the node then holds none, so the pair stays plain on both sides.
  if (body.approvalKey !== undefined && (typeof body.approvalKey !== 'string' || !APPROVAL_KEY_PATTERN.test(body.approvalKey))) {
    logger.error('Rings answered with an approval key Buckle does not accept')
    return { ok: false, message: `${paired}\nRings answered with an approval key Buckle does not accept (it must be 32 bytes in base64url), so nothing was written to ${input.environmentFile}. Check that the Rings URL is the one you meant, then pair again.` }
  }
  const approvalKey = typeof body.approvalKey === 'string' ? body.approvalKey : null
  const recorded = await recordReportCredential({ ...input, reportToken: body.reportToken, approvalKey })
  return { ok: recorded.ok, message: `${paired}\n${recorded.message}` }
}

/**
 * Rings mints this node a report credential during pairing, readable in that answer alone, and
 * refuses a report filed for a node the credential does not belong to. It is written straight into
 * the environment file, never printed and never passed in argv, along with the two Rings routes it
 * authenticates: the action log, and the approvals a person has to be reached about. The approval
 * key of `RINGS-D20` travels the same way and is removed when Rings sent none.
 *
 * Rings stored the new credential and key before it answered, so a file that is not written
 * leaves the pair unable to talk: that is a failed pairing, and the owner is told to pair again.
 */
async function recordReportCredential(input: { environmentFile: string; ringsUrl: string; reportToken: string; approvalKey: string | null; home?: string }): Promise<PairingResult> {
  const settings = [
    { name: 'BUCKLE_REPORT_URL', value: new URL(REPORT_PATH, input.ringsUrl).toString() },
    { name: 'BUCKLE_REPORT_TOKEN', value: input.reportToken },
    { name: 'BUCKLE_APPROVAL_WEBHOOK', value: new URL(APPROVALS_PATH, input.ringsUrl).toString() },
    { name: 'BUCKLE_RINGS_APPROVAL_KEY', value: input.approvalKey },
  ]
  const edit = (text: string): EnvironmentEdit => settings.reduce<EnvironmentEdit>(
    (carried, setting) => (carried.ok ? editEnvironmentVariable({ text: carried.text, ...setting }) : carried),
    { ok: true, text },
  )
  const minted = input.approvalKey ? 'report credential and approval key' : 'report credential'
  const unsaved = `The ${minted} Rings minted for this node were not saved, and Rings already holds them, so reports and approvals between Rings and this node fail until it is paired again.`
  try {
    if (!(await updateEnvironmentFile(input.environmentFile, edit, { ...(input.home ? { home: input.home } : {}) })).ok) {
      return { ok: false, message: `${unsaved} ${input.environmentFile} sets one of BUCKLE_REPORT_URL, BUCKLE_REPORT_TOKEN, BUCKLE_APPROVAL_WEBHOOK or BUCKLE_RINGS_APPROVAL_KEY in a form Buckle does not edit. Fix those lines by hand, then ${REPAIR}.` }
    }
  } catch (error) {
    logger.error('Could not write the report credential Rings minted', { message: error instanceof Error ? error.message : 'Unknown error' })
    return { ok: false, message: `${unsaved} ${input.environmentFile} could not be written. Once it is writable, ${REPAIR}.` }
  }
  return { ok: true, message: `Its action log and pending approvals now report to Rings under this node's own credential, written to ${input.environmentFile}. Restart any running Buckle service to load the new credential.` }
}

async function errorText(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null
  return typeof body?.error === 'string' ? body.error : 'no reason given'
}
