import { readFileSync } from 'node:fs'
import { join } from 'pathe'
import { PACKAGE_ROOT } from './package-root.js'

/**
 * Read from package.json rather than copied into the source, so the version Buckle advertises
 * to Rings cannot drift from the version that was published.
 */
export const BUCKLE_VERSION: string = readVersion()

/** What a build recorded of the commit it was made from (scripts/build-info.mjs). */
export interface BuildStamp { commit: string; dirty: boolean; builtAt?: string }

/**
 * The version as `buckle --version`, the serve log, and the manifest's `build` show it: `0.1.8+670f1dc2`, with `.dirty`
 * where the build had uncommitted changes, from the stamp the build wrote beside dist (dist/build-info.json, two folders
 * above this module there). The sources and a package built from its release tag hold none, and show the plain version.
 */
export const BUCKLE_BUILD: string = stampedVersion(BUCKLE_VERSION, buildStampOf(join(import.meta.dirname, '..', '..', 'build-info.json')))

export function stampedVersion(version: string, stamp: Pick<BuildStamp, 'commit' | 'dirty'> | null): string {
  return stamp === null ? version : `${version}+${stamp.commit}${stamp.dirty ? '.dirty' : ''}`
}

/** The stamp at `file`; null where there is none or it is not one a build writes, so nothing else reaches the version. */
export function buildStampOf(file: string): BuildStamp | null {
  let raw: unknown
  try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const { commit, dirty, builtAt } = raw as Record<string, unknown>
  if (typeof commit !== 'string' || !/^[0-9a-f]{7,40}$/.test(commit) || typeof dirty !== 'boolean') return null
  return { commit, dirty, ...(typeof builtAt === 'string' ? { builtAt } : {}) }
}

function readVersion(): string {
  const raw = readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')
  return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0'
}
