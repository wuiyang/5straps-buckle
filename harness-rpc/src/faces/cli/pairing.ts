import { writeFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { createDeferredApprovalChannel } from '../../adapters/approval/deferred-approval-channel.js'
import { loadConfig } from '../../config.js'
import { logger } from '../../logger.js'
import { createRuntime } from '../../runtime.js'
import { setEnvironmentVariable } from './environment-file.js'

/** Where Rings takes a node's action log and its pending approvals. */
const REPORT_PATH = '/api/v1/buckle-reports'
const APPROVALS_PATH = '/api/v1/buckle-approvals'

export interface PairingRequest {
  /** The code the owner read off Rings. Short-lived and single use, so argv is where it belongs. */
  code: string
  ringsUrl: string
  /** Where Rings will reach this node. The default only works when Rings runs on this host. */
  baseUrl: string
  /** The environment file just written or reused: the credentials never leave it in argv. */
  environmentFile: string
  environmentText: string
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
  const config = loadConfig(environment)
  const runtime = await createRuntime({ config, channel: () => createDeferredApprovalChannel() })

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
    }),
  }).catch((error: unknown) => {
    logger.error('Pairing request failed', { message: error instanceof Error ? error.message : 'Unknown error' })
    return null
  })

  if (!response) return { ok: false, message: `Could not reach Rings at ${input.ringsUrl}. The node is configured in ${input.environmentFile}; pair it again once Rings is reachable.` }
  if (!response.ok) return { ok: false, message: `Rings refused the pairing code (HTTP ${response.status}): ${await errorText(response)}` }

  const body = await response.json().catch(() => null) as { server?: { id?: string; name?: string }; reportToken?: string } | null
  const paired = `Paired with Rings as ${body?.server?.name ?? config.serverName} (${body?.server?.id ?? config.serverId}).`
  if (!body?.reportToken) {
    // A Rings built before per-node report credentials answers without one; its installation-wide
    // token stays configured by hand, so the node is paired either way.
    logger.warn('Rings did not mint a report credential for this node; set BUCKLE_REPORT_URL and BUCKLE_REPORT_TOKEN by hand to report the action log')
    return { ok: true, message: paired }
  }
  return { ok: true, message: `${paired}\n${recordReportCredential({ ...input, reportToken: body.reportToken })}` }
}

/**
 * Rings mints this node a report credential during pairing, readable in that answer alone, and
 * refuses a report filed for a node the credential does not belong to. It is written straight into
 * the environment file, never printed and never passed in argv, along with the two Rings routes it
 * authenticates: the action log, and the approvals a person has to be reached about.
 */
function recordReportCredential(input: { environmentFile: string; environmentText: string; ringsUrl: string; reportToken: string }): string {
  const settings = [
    { name: 'BUCKLE_REPORT_URL', value: new URL(REPORT_PATH, input.ringsUrl).toString() },
    { name: 'BUCKLE_REPORT_TOKEN', value: input.reportToken },
    { name: 'BUCKLE_APPROVAL_WEBHOOK', value: new URL(APPROVALS_PATH, input.ringsUrl).toString() },
  ]
  const text = settings.reduce((carried, setting) => setEnvironmentVariable({ text: carried, ...setting }), input.environmentText)
  try {
    writeFileSync(input.environmentFile, text, { mode: 0o600 })
  } catch (error) {
    logger.error('Could not write the report credential Rings minted', { message: error instanceof Error ? error.message : 'Unknown error' })
    return `Rings minted a report credential for this node, but ${input.environmentFile} could not be written; pair again once it is writable, or the action log is reported under the installation-wide token instead.`
  }
  return `Its action log and pending approvals now report to Rings under this node's own credential, written to ${input.environmentFile}.`
}

async function errorText(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null
  return typeof body?.error === 'string' ? body.error : 'no reason given'
}
