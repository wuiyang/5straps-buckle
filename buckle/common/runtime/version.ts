import { readFileSync } from 'node:fs'
import { join } from 'pathe'
import { PACKAGE_ROOT } from './package-root.js'

/**
 * Read from package.json rather than copied into the source, so the version Buckle advertises
 * to Rings cannot drift from the version that was published.
 */
export const BUCKLE_VERSION: string = readVersion()

function readVersion(): string {
  const raw = readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')
  return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0'
}
