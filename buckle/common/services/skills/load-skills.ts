import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'pathe'
import { buildSkill, type LoadedSkill } from '../../domain/skill.js'
import { isMissingPathError } from '../../domain/filesystem-errors.js'
import { isPlainName } from '../../domain/paths.js'

/** Operator-supplied skills from configured directories, alongside the skills packs ship. */
export async function loadSkills(directories: string[]): Promise<LoadedSkill[]> {
  const skills: LoadedSkill[] = []
  for (const configured of directories) {
    const directory = resolve(configured)
    for (const path of await findSkillFiles(directory)) {
      const content = await readFile(path, 'utf8')
      const id = `local:${createHash('sha256').update(path).digest('hex').slice(0, 12)}`
      skills.push(buildSkill({ content, path, pack: null, id }))
    }
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name))
}

async function findSkillFiles(directory: string): Promise<string[]> {
  const info = await stat(directory)
  if (!info.isDirectory()) throw new Error(`Skill path is not a directory: ${directory}`)

  if (await isFile(join(directory, 'SKILL.md'))) return [join(directory, 'SKILL.md')]

  const files: string[] = []
  for (const child of await readdir(directory, { withFileTypes: true })) {
    if (!child.isDirectory() || !isPlainName(child.name)) continue
    const candidate = join(directory, child.name, 'SKILL.md')
    if (await isFile(candidate)) files.push(candidate)
  }
  return files
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if (isMissingPathError(error)) return false
    throw error
  }
}
