import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** Every TypeScript and JavaScript source under the given package-relative paths; a path not there yet is skipped. */
export function sourceFiles(...paths: string[]): string[] {
  return paths.map(path => join(PACKAGE_ROOT, path)).filter(path => existsSync(path)).flatMap(walk)
}

function walk(path: string): string[] {
  if (statSync(path).isFile()) return /\.(?:ts|mts|mjs|js)$/.test(path) ? [path] : []
  return readdirSync(path).filter(name => name !== 'node_modules').flatMap(name => walk(join(path, name)))
}
