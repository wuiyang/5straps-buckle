import { existsSync } from 'node:fs'
import { join, normalize } from 'pathe'
import { parentDirectory } from '../domain/paths.js'

// The sources (common/runtime) and the build (dist/common/runtime) sit at different depths.
export const PACKAGE_ROOT = findPackageRoot(normalize(import.meta.dirname))

/** The built CLI entry, which a service definition and `buckle serve --background` run with Node by its absolute path. */
export function builtMainPath(): string {
  return join(PACKAGE_ROOT, 'dist', 'main.js')
}

function findPackageRoot(start: string): string {
  for (let directory = start; ; directory = parentDirectory(directory)) {
    if (existsSync(join(directory, 'package.json'))) return directory
    if (parentDirectory(directory) === directory) throw new Error(`No package.json above ${start}`)
  }
}
