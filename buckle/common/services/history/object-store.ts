import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { constants as zlib, deflate, inflate, inflateSync } from 'node:zlib'
import { join } from 'pathe'
import { replaceFile } from '../../adapters/replace-file.js'

const deflated = promisify(deflate)
const inflated = promisify(inflate)
const OBJECT_ID = /^[0-9a-f]{40}$/
/** The folder below the history's own where its blobs lie, git's loose layout: blobs/ab/cdef… (never `objects`, which the old shadow-git upkeep walks). */
const BLOBS = 'blobs'

/** A blob the store holds no longer reads back as its id: missing, unreadable, or changed on disk since it was written. */
export class HistoryContentError extends Error {}

/** A blob's git object id: SHA-1 over `blob <size>\0` and the content, as `git hash-object` names it. */
export function blobId(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex')
}

export type ObjectStore = ReturnType<typeof openObjectStore>

/**
 * History's content (Slice F2, item 4): each captured file as a zlib loose git blob keyed by its SHA-1 object id, under
 * the workspace's history folder, written and read in-process, so neither a capture nor a restore starts git, and no
 * object is borrowed from the owner's repository (A5). A read checks the bytes against their id (A12), and drops a copy
 * that fails, so the next capture of that content writes it again.
 */
export function openObjectStore(directory: string) {
  const root = join(directory, BLOBS)

  function pathOf(id: string): string {
    if (!OBJECT_ID.test(id)) throw new Error('Invalid history object id')
    return join(root, id.slice(0, 2), id.slice(2))
  }
  function sizeAt(path: string): number | undefined {
    const stat = lstatSync(path, { throwIfNoEntry: false })
    return stat?.isFile() ? stat.size : undefined
  }

  async function put(content: Buffer): Promise<string> {
    const id = blobId(content)
    const path = pathOf(id)
    if (sizeAt(path) !== undefined) return id
    const folder = join(root, id.slice(0, 2))
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    const packed = await deflated(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content]), { level: zlib.Z_BEST_SPEED })
    const temporary = join(folder, `tmp-${randomUUID()}`)
    try {
      writeFileSync(temporary, packed, { mode: 0o600, flag: 'wx' })
      await replaceFile(temporary, path)
    } finally { rmSync(temporary, { force: true }) }
    return id
  }

  async function read(id: string): Promise<Buffer> {
    const path = pathOf(id)
    let packed: Buffer
    try { packed = await readFile(path) } catch (error) { throw new HistoryContentError(`History content ${id} is missing`, { cause: error }) }
    let raw: Buffer
    try { raw = await inflated(packed) } catch (error) { forget(path); throw new HistoryContentError(`History content ${id} is damaged`, { cause: error }) }
    const header = raw.indexOf(0)
    const size = header > 0 ? raw.subarray(0, header).toString('latin1').match(/^blob (0|[1-9][0-9]*)$/)?.[1] : undefined
    const content = raw.subarray(header + 1)
    if (size === undefined || Number(size) !== content.length || blobId(content) !== id) {
      forget(path)
      throw new HistoryContentError(`History content ${id} no longer matches its id`)
    }
    return content
  }

  /** The size of the content `id` names, read from its header alone; undefined where the store does not hold it. */
  function size(id: string): number | undefined {
    let packed: Buffer
    try { packed = readFileSync(pathOf(id)) } catch { return undefined }
    let raw: Buffer
    try { raw = inflateSync(packed.subarray(0, 512), { finishFlush: zlib.Z_SYNC_FLUSH }) } catch { return undefined }
    const header = raw.subarray(0, Math.max(0, raw.indexOf(0))).toString('latin1').match(/^[a-z]+ (0|[1-9][0-9]*)$/)?.[1]
    return header === undefined ? undefined : Number(header)
  }

  function forget(path: string): void { rmSync(path, { force: true }) }

  function list(): string[] {
    const ids: string[] = []
    const folders = lstatSync(root, { throwIfNoEntry: false })?.isDirectory() ? readdirSync(root) : []
    for (const folder of folders) {
      if (!/^[0-9a-f]{2}$/.test(folder)) continue
      for (const name of readdirSync(join(root, folder))) if (/^[0-9a-f]{38}$/.test(name)) ids.push(folder + name)
    }
    return ids
  }

  return {
    put,
    read,
    has: (id: string): boolean => sizeAt(pathOf(id)) !== undefined,
    size,
    /** The bytes `id` takes on disk; undefined where the store does not hold it. */
    stored: (id: string): number | undefined => sizeAt(pathOf(id)),
    /** The folder git writes its loose objects to beside these, so both share one (Slice F2, item 3). */
    root,
    remove: (id: string): void => forget(pathOf(id)),
    list,
  }
}
