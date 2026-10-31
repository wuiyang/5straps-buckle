import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { join } from 'pathe'

/**
 * Every object a workspace history's store holds, inflated, header and all: a file tool's blobs and the loose objects git
 * writes for a command share the one folder (Slice F2, items 3 and 4). What a test checks no private byte ever reached.
 */
export function historyObjects(directory: string): Buffer[] {
  const root = join(directory, 'blobs')
  if (!existsSync(root)) return []
  return readdirSync(root).filter(name => /^[0-9a-f]{2}$/.test(name)).flatMap(folder => readdirSync(join(root, folder)).filter(name => /^[0-9a-f]{38}$/.test(name)).map(name => inflateSync(readFileSync(join(root, folder, name)))))
}
