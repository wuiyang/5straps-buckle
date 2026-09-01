import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Read from package.json rather than copied into the source, so the version Buckle advertises
 * to Rings cannot drift from the version that was published. Both src/ and dist/ sit one
 * directory below the package root, so the same relative path works in dev and after a build.
 */
export const BUCKLE_VERSION: string = readVersion()

function readVersion(): string {
  const raw = readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')
  return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0'
}
