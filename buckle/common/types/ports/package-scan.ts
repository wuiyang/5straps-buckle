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
 * Looks up package versions by their package URLs (`pkg:npm/<name>@<version>`), each answered with Socket's summary, or
 * null where the scanner has none: no key, a timeout, an error, or a package it does not know. It never throws.
 */
export interface PackageScanner {
  scan(purls: readonly string[], signal?: AbortSignal): Promise<Map<string, SocketSummary | null>>
}

/** The scanner of a node with no Socket key: every package is answered with null. */
export const nullPackageScanner: PackageScanner = {
  scan: purls => Promise.resolve(new Map(purls.map(purl => [purl, null]))),
}
