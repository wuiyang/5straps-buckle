import { z } from 'zod'
import { npmPackageUrl, type PackageScanner, type SocketSummary } from '../../types/ports/package-scan.js'

/** Where Socket's API answers when the node names no BUCKLE_SOCKET_BASE_URL. */
export const SOCKET_API_URL = 'https://api.socket.dev'

/** How long one scan may take, the organization lookup and the retry included (D91, addendum 2 C). */
export const SOCKET_TIMEOUT_MS = 10_000

/** The most alerts kept for one package, so a package Socket flags often cannot crowd out the code the judge reads. */
const ALERT_LIMIT = 50

const Score = z.number().min(0).max(1).nullable().optional()
const ArtifactSchema = z.object({
  inputPurl: z.string().optional(),
  type: z.string().optional(),
  namespace: z.string().nullable().optional(),
  name: z.string().optional(),
  version: z.string().optional(),
  score: z.object({ overall: Score, supplyChain: Score, quality: Score, maintenance: Score, vulnerability: Score, license: Score }).optional(),
  alerts: z.array(z.object({ type: z.string(), severity: z.string().optional() })).optional(),
})
const OrganizationsSchema = z.object({ organizations: z.record(z.string(), z.object({ slug: z.string().min(1) })) })

/**
 * Socket's view of package versions over its API (D91, addendum 2 C), on plain fetch with the node's key as HTTP basic
 * auth, the key as the user name and an empty password (docs.socket.dev/reference/authentication). The batch route the
 * brief named, POST /v0/purl, is deprecated since 2026-01-05; its successor is organization scoped, so the key's own
 * organization is looked up once (GET /v0/organizations) and every batch goes to POST /v0/orgs/<slug>/purl?alerts=true
 * (docs.socket.dev/reference/batchpackagefetchbyorg), answered as NDJSON, one artifact a line. `compact` is not sent:
 * Socket's compact form leaves the scores out. A network failure, a 429, or a 5xx is tried once more within the time. Every
 * failure answers null for each package and is never thrown, logged, or shown: Socket is advisory. `fetch` is for tests.
 */
export function createSocketScanner(options: { apiKey: string; baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number }): PackageScanner {
  const base = (options.baseUrl ?? SOCKET_API_URL).replace(/\/+$/, '')
  const send = options.fetch ?? fetch
  const authorization = `Basic ${Buffer.from(`${options.apiKey}:`).toString('base64')}`
  let organization: Promise<string | null> | undefined

  async function requested(path: string, init: RequestInit): Promise<Response | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await settled(send(`${base}${path}`, { ...init, headers: { authorization, accept: 'application/json, application/x-ndjson', ...init.headers } }), init.signal)
        if (response.ok || (response.status !== 429 && response.status < 500)) return response.ok ? response : null
      } catch (error) {
        if (init.signal?.aborted) throw error
      }
    }
    return null
  }

  async function organizationOf(signal: AbortSignal): Promise<string | null> {
    const response = await requested('/v0/organizations', { method: 'GET', signal })
    const parsed = response ? OrganizationsSchema.safeParse(JSON.parse(await settled(response.text(), signal))) : null
    return parsed?.success ? Object.values(parsed.data.organizations)[0]?.slug ?? null : null
  }

  return {
    async scan(purls, signal) {
      const answers = new Map<string, SocketSummary | null>(purls.map(purl => [purl, null]))
      if (purls.length === 0) return answers
      const timeout = AbortSignal.timeout(options.timeoutMs ?? SOCKET_TIMEOUT_MS)
      const abort = signal ? AbortSignal.any([signal, timeout]) : timeout
      try {
        organization ??= organizationOf(abort).then(slug => { if (slug === null) organization = undefined; return slug }, () => { organization = undefined; return null })
        const slug = await organization
        if (slug === null) return answers
        const response = await requested(`/v0/orgs/${encodeURIComponent(slug)}/purl?alerts=true`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ components: purls.map(purl => ({ purl })) }),
          signal: abort,
        })
        if (!response) return answers
        for (const line of (await settled(response.text(), abort)).split('\n')) {
          const artifact = artifactOf(line)
          if (artifact && answers.has(artifact.purl)) answers.set(artifact.purl, artifact.summary)
        }
      } catch {
        // Advisory: the rating runs without Socket's view.
      }
      return answers
    },
  }
}

/** A promise that rejects once `signal` aborts, whatever the fetch it waits on does with the signal. */
function settled<T>(promise: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    if (signal.aborted) return aborted()
    signal.addEventListener('abort', aborted, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', aborted); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', aborted); reject(error) },
    )
  })
}

/** One NDJSON line as the package URL it answers and Socket's summary; null for an error or summary line, or anything else. */
function artifactOf(line: string): { purl: string; summary: SocketSummary } | null {
  if (line.trim() === '') return null
  let value: unknown
  try { value = JSON.parse(line) } catch { return null }
  if (typeof value !== 'object' || value === null || '_type' in value) return null
  const parsed = ArtifactSchema.safeParse(value)
  if (!parsed.success) return null
  const { data } = parsed
  const purl = data.inputPurl ?? (data.type === 'npm' && data.name && data.version ? npmPackageUrl(data.namespace ? `${data.namespace}/${data.name}` : data.name, data.version) : null)
  if (purl === null) return null
  const score = data.score ?? {}
  return {
    purl,
    summary: {
      score: { overall: score.overall ?? null, supplyChain: score.supplyChain ?? null, quality: score.quality ?? null, maintenance: score.maintenance ?? null, vulnerability: score.vulnerability ?? null, license: score.license ?? null },
      alerts: (data.alerts ?? []).slice(0, ALERT_LIMIT).map(alert => ({ type: alert.type, severity: alert.severity ?? 'unknown' })),
    },
  }
}
