import { findExecutable } from '../../common/domain/executable.js'

export function hasExecutable(
  binary: string,
  environment?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
): boolean {
  return findExecutable(binary, environment, platform) !== null
}
