import { cp, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const PACKS = 'common/services/packs'

// tsc does not copy markdown, and both the packs and the entry-point skill ship SKILL.md.
for (const entry of await readdir(PACKS, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  await cp(join(PACKS, entry.name, 'SKILL.md'), join('dist', PACKS, entry.name, 'SKILL.md')).catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
}
