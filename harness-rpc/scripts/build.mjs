// Builds the package into dist (or --out-dir <dir>): tsc, then what tsc leaves out.
import { execFileSync } from 'node:child_process'
import { chmod, cp, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const PACKS = 'common/services/packs'
const { values } = parseArgs({ options: { 'out-dir': { type: 'string', default: 'dist' } } })
const outDir = resolve(values['out-dir'])

await rm(outDir, { recursive: true, force: true })
execFileSync(process.execPath, [createRequire(import.meta.url).resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json', '--outDir', outDir], { stdio: 'inherit' })
await copyPackSkills()
// The bin runs through a symlink (npm link, a global install), so it needs its own executable bit.
await chmod(join(outDir, 'main.js'), 0o755)

// tsc does not copy markdown, and both the packs and the entry-point skill ship SKILL.md.
async function copyPackSkills() {
  for (const entry of await readdir(PACKS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    await cp(join(PACKS, entry.name, 'SKILL.md'), join(outDir, PACKS, entry.name, 'SKILL.md')).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}
