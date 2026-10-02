/** Directories skipped by tree walks. Keeps `fs_list` and `fs_find_names` off build output. */
export const DEFAULT_IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.venv',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  '.cache',
  '.gradle',
  '__pycache__',
  'node_modules',
  'venv',
  'target',
  'dist',
  'build',
  'coverage',
  'vendor',
])

export function isIgnoredDirectory(name: string, includeIgnored: boolean): boolean {
  return !includeIgnored && DEFAULT_IGNORED_DIRECTORIES.has(name)
}
