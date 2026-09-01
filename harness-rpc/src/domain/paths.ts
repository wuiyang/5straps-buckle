import { isAbsolute, relative, resolve, sep } from 'node:path'

/** True when candidate is the directory itself or sits underneath it. Both must be absolute. */
export function isInside(directory: string, candidate: string): boolean {
  const fromDirectory = relative(resolve(directory), resolve(candidate))
  if (fromDirectory === '') return true
  return !fromDirectory.startsWith('..') && !isAbsolute(fromDirectory)
}

export function isInsideAny(directories: string[], candidate: string): boolean {
  return directories.some(directory => isInside(directory, candidate))
}

/** Path segments, case-folded, for pattern rules that must not be defeated by casing. */
export function segments(path: string): string[] {
  return path.split(sep).filter(Boolean).map(segment => segment.toLowerCase())
}
