import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Node realpaths the main module, so the comparison must too: a gate script run through a symlinked
// path has to run its check, never skip it and exit 0.
export function isEntryPoint(moduleUrl) {
  return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl))
}
