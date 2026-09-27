import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

// The sources (common/runtime) and the build (dist/common/runtime) sit at different depths.
export const PACKAGE_ROOT = findPackageRoot(import.meta.dirname)

function findPackageRoot(start: string): string {
  for (let directory = start; ; directory = dirname(directory)) {
    if (existsSync(join(directory, 'package.json'))) return directory
    if (dirname(directory) === directory) throw new Error(`No package.json above ${start}`)
  }
}
