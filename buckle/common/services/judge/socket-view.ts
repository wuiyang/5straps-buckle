import type { JudgeInput } from '../../types/ports/judge.js'
import { npmPackageUrl, PACKAGE_SCAN_LIMIT, type PackageScanner, type SocketSummary } from '../../types/ports/package-scan.js'

/**
 * The input with Socket's view of each package version beside it (D91, addendum 2 C): the first PACKAGE_SCAN_LIMIT
 * packages that carry a version are looked up, and past that the rest keep none and the input says packagesTruncated.
 * Advisory: a scanner with no key, or one that fails, leaves every summary null and the rating runs.
 */
export async function withSocket(asked: JudgeInput, scanner: PackageScanner, signal?: AbortSignal): Promise<JudgeInput> {
  const versioned = asked.packages.flatMap(item => (item.version === null ? [] : [{ name: item.name, version: item.version }]))
  const looked = new Map(versioned.slice(0, PACKAGE_SCAN_LIMIT).map(item => [item.name, npmPackageUrl(item.name, item.version)]))
  const packagesTruncated = versioned.length > PACKAGE_SCAN_LIMIT
  if (looked.size === 0) return { ...asked, packagesTruncated }
  const summaries = await scanner.scan([...looked.values()], signal).catch(() => new Map<string, SocketSummary | null>())
  return {
    ...asked,
    packagesTruncated,
    packages: asked.packages.map((item) => {
      const purl = looked.get(item.name)
      return purl === undefined ? item : { ...item, socket: summaries.get(purl) ?? null }
    }),
  }
}
