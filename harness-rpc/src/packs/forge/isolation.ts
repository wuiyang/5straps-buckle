import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isInside } from '../../domain/paths.js'
import { ToolInputError } from '../../domain/tool.js'
import { gitDirectory, readBounded, readRepositoryConfig } from './remote.js'

/** `[filter "name"]`, whose `clean`, `smudge` and `process` values are programs `git add` runs. */
const FILTER_SECTION_PATTERN = /^\s*\[\s*filter\b/i
/** A `filter=driver` attribute, which is what points a path at such a program. */
const FILTER_ATTRIBUTE_PATTERN = /(?:^|\s)filter=\S/
const MAX_ATTRIBUTES_BYTES = 262_144

/**
 * A clean filter is a program the repository names and `git add` runs, before anything else this
 * pack does. `filter.<name>.*` is a config section rather than one key, so the override scope
 * cannot reset it; the repository is refused instead, the way an `include` is. Emptying the
 * driver, which is what the read-only git pack does, is not an option here: the commit would
 * then carry content the repository means to convert.
 *
 * This reads the one file, which is what keeps a repository that plainly defines a driver from
 * spawning git at all. It is not the whole of the guard: `assertNoFilterPrograms` asks git which
 * drivers it really resolves, because `.git/config.worktree` is a scope this text does not name.
 * The attributes files are checked as well, and are not what closes this either: staging a
 * directory reaches a `.gitattributes` below the named path.
 */
export function assertNoFilters(input: { repository: string; paths: string[] }): void {
  const config = readRepositoryConfig(input.repository)
  if (config.split('\n').some(line => FILTER_SECTION_PATTERN.test(line))) {
    throw new ToolInputError(`${input.repository} has a git config defining a filter driver, whose clean program git runs while staging; the forge tools refuse the repository rather than running workspace code under the node's identity`, { code: 'PERMISSION_DENIED' })
  }
  for (const file of attributeFiles(input)) {
    const content = readBounded({ path: file, maxBytes: MAX_ATTRIBUTES_BYTES, subject: `${file} is not an attributes file the forge tools can read` })
    if (!FILTER_ATTRIBUTE_PATTERN.test(content)) continue
    throw new ToolInputError(`${file} gives a committed path a filter attribute, and a filter names a program git runs while staging; the forge tools refuse the commit rather than running it`, { code: 'PERMISSION_DENIED' })
  }
}

/**
 * The filter drivers git itself resolves here, refused whatever scope defines them. Reading
 * `.git/config` is not enough: `extensions.worktreeConfig` turns on `.git/config.worktree`, which
 * that text does not name, and a driver defined there ran its clean program on this host during
 * `git add` for any path a nested `.gitattributes` gave a filter attribute.
 */
export function assertNoFilterPrograms(input: { repository: string; keys: string[] }): void {
  const [defined] = input.keys
  if (!defined) return
  throw new ToolInputError(`${input.repository} defines the git filter program ${defined}, whose value is a program git runs while staging; the forge tools refuse the repository rather than running workspace code under the node's identity`, { code: 'PERMISSION_DENIED' })
}

/** The attributes files git consults for the named paths: one per directory above each, plus `.git/info/attributes`. */
function attributeFiles(input: { repository: string; paths: string[] }): string[] {
  const files = new Set<string>([join(gitDirectory(input.repository), 'info', 'attributes')])
  for (const named of input.paths) {
    let directory = join(input.repository, named)
    while (isInside(input.repository, directory)) {
      files.add(join(directory, '.gitattributes'))
      if (directory === input.repository) break
      directory = dirname(directory)
    }
  }
  return [...files].filter(file => existsSync(file))
}
