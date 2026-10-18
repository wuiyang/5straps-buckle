/**
 * Socket's view of one third-party package version (D91, addendum 2 C): its scores, each from 0 to 1 where Socket gives
 * one, and the alerts it raises, by type and severity. Advisory: the decision AI reads it beside the code, and nothing
 * here runs or refuses a call on its own.
 */
export interface SocketSummary {
  score: { overall: number | null; supplyChain: number | null; quality: number | null; maintenance: number | null; vulnerability: number | null; license: number | null }
  alerts: Array<{ type: string; severity: string }>
}

/**
 * What one lookup answered: each package URL's summary, or null where there is none, and whether the lookup failed (a
 * timeout, an error, or an unreachable host), apart from a scanner with no key or a package Socket does not know, which
 * is no failure (fix brief 2, H11).
 */
export interface PackageScan {
  summaries: Map<string, SocketSummary | null>
  failed: boolean
}

/**
 * Looks up package versions by their package URLs (`pkg:npm/<name>@<version>`), each answered with Socket's summary, or
 * null where the scanner has none: no key, a timeout, an error, or a package it does not know. It never throws.
 */
export interface PackageScanner {
  scan(purls: readonly string[], signal?: AbortSignal): Promise<PackageScan>
}

/** The most packages one rating looks up at Socket (D91, addendum 2 C); past it the rest keep no summary. */
export const PACKAGE_SCAN_LIMIT = 50

/** An npm package version's package URL as the purl spec writes it: `pkg:npm/%40scope/name@1.2.3`. */
export function npmPackageUrl(name: string, version: string): string {
  const slash = name.startsWith('@') ? name.indexOf('/') : -1
  const namespace = slash > 0 ? `${encodeURIComponent(name.slice(0, slash))}/` : ''
  return `pkg:npm/${namespace}${encodeURIComponent(slash > 0 ? name.slice(slash + 1) : name)}@${encodeURIComponent(version)}`
}

/** The scanner of a node with no Socket key: every package is answered with null. */
export const nullPackageScanner: PackageScanner = {
  scan: purls => Promise.resolve({ summaries: new Map(purls.map(purl => [purl, null])), failed: false }),
}
