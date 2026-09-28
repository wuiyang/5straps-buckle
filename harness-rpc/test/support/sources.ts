import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** The extensions Nitro's scan reads (GLOB_SCAN_PATTERN, nitro@3.0.260903-beta dist/_chunks/nitro2.mjs). */
export const SCAN_EXTENSION = /\.(?:js|mjs|cjs|ts|mts|cts|tsx|jsx)$/

/** Every source Nitro would scan under the given package-relative paths; a path not there yet is skipped. */
export function sourceFiles(...paths: string[]): string[] {
  return paths.map(path => join(PACKAGE_ROOT, path)).filter(path => existsSync(path)).flatMap(walk)
}

function walk(path: string): string[] {
  if (statSync(path).isFile()) return SCAN_EXTENSION.test(path) ? [path] : []
  return readdirSync(path).filter(name => name !== 'node_modules').flatMap(name => walk(join(path, name)))
}
