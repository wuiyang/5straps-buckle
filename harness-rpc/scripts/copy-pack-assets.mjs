import { cp, readdir } from 'node:fs/promises'
import { join } from 'node:path'

// tsc does not copy markdown, and both the packs and the entry-point skill ship SKILL.md.
for (const entry of await readdir('src/packs', { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  await cp(join('src/packs', entry.name, 'SKILL.md'), join('dist/packs', entry.name, 'SKILL.md')).catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
}
