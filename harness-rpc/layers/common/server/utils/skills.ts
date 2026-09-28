import type { LoadedSkill } from '../../../../common/domain/skill.js'

/** A skill as an agent reads it: its descriptor and content, never the path it was loaded from. */
export function skillBody({ path: _path, ...skill }: LoadedSkill): Omit<LoadedSkill, 'path'> {
  return skill
}
