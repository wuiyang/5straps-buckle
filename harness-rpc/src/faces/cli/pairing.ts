import { parseEnv } from 'node:util'
import { createDeferredApprovalChannel } from '../../adapters/approval/deferred-approval-channel.js'
import { loadConfig } from '../../config.js'
import { logger } from '../../logger.js'
import { createRuntime } from '../../runtime.js'

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

  const body = await response.json().catch(() => null) as { server?: { id?: string; name?: string } } | null
  return { ok: true, message: `Paired with Rings as ${body?.server?.name ?? config.serverName} (${body?.server?.id ?? config.serverId}).` }
}

async function errorText(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null
  return typeof body?.error === 'string' ? body.error : 'no reason given'
}
