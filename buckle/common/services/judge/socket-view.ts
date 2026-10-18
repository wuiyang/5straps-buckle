import type { JudgeInput } from '../../types/ports/judge.js'
import { npmPackageUrl, PACKAGE_SCAN_LIMIT, type PackageScanner, type SocketSummary } from '../../types/ports/package-scan.js'

/**
 * The input with Socket's view of each package version beside it (D91, addendum 2 C): the first PACKAGE_SCAN_LIMIT
 * packages that carry a version are looked up, and past that the rest keep none and the input says packagesTruncated.
 * Advisory: a scanner with no key, or one that fails, leaves every summary null and the rating runs; `failed` says the
 * lookup failed (fix brief 2, H11), so a verdict reached without Socket's view is used for this call and not kept.
 */
export async function withSocket(asked: JudgeInput, scanner: PackageScanner, signal?: AbortSignal): Promise<{ input: JudgeInput; failed: boolean }> {
  // By package URL, so each version of a package gets its own summary (fix brief 1, item 10).
  const versioned = [...new Set(asked.packages.flatMap(item => (item.version === null ? [] : [npmPackageUrl(item.name, item.version)])))]
  const looked = new Set(versioned.slice(0, PACKAGE_SCAN_LIMIT))
  const packagesTruncated = versioned.length > PACKAGE_SCAN_LIMIT
  if (looked.size === 0) return { input: { ...asked, packagesTruncated }, failed: false }
  const { summaries, failed } = await scanner.scan([...looked], signal).catch(() => ({ summaries: new Map<string, SocketSummary | null>(), failed: true }))
  return {
    input: {
      ...asked,
      packagesTruncated,
      packages: asked.packages.map((item) => {
        const purl = item.version === null ? undefined : npmPackageUrl(item.name, item.version)
        return purl === undefined || !looked.has(purl) ? item : { ...item, socket: summaries.get(purl) ?? null }
      }),
    },
    failed,
  }
}
