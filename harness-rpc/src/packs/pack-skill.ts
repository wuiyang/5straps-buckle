import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildSkill, type LoadedSkill } from '../domain/skill.js'

/** Each pack ships a SKILL.md next to its source; the build copies them beside the output. */
export function loadPackSkill(packId: string): LoadedSkill {
  const path = join(import.meta.dirname, packId, 'SKILL.md')
  return buildSkill({ content: readFileSync(path, 'utf8'), path, pack: packId, id: `pack:${packId}` })
}

/** The entry-point skill teaching a harness how to drive Buckle and handle its approvals. */
export function loadRootSkill(): LoadedSkill {
  const path = join(import.meta.dirname, '..', '..', 'skills', 'buckle', 'SKILL.md')
  return buildSkill({ content: readFileSync(path, 'utf8'), path, pack: null, id: 'buckle' })
}
