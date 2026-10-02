import { tmpdir } from 'node:os'

const PLAIN_SEGMENT = /^[a-z0-9._-]*$/

/**
 * Where tests make their temp directories: the system temp directory when every segment of its path is a
 * plain lowercase name, /tmp otherwise. Log redaction blanks a whole long path when one segment does not
 * read as words, such as macOS or bfcT (src/logger/sanitize.ts), and tests compare logged paths with the
 * paths they made, so a temp directory under such a name would fail them.
 */
export function plainTempRoot(system: string = tmpdir()): string {
  return system.split('/').every(segment => PLAIN_SEGMENT.test(segment)) ? system : '/tmp'
}
