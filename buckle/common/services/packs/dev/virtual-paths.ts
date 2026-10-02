import { fileURLToPath, pathToFileURL } from 'node:url'
import type { JsonValue } from '@5straps/protocol'
import type { PathView } from '../../../domain/path-view.js'

/**
 * A language server answers in `file://` URIs naming the real host path, as values and, in a
 * workspace edit, as object keys. Under a mount the agent must see none of them, so every URI
 * in a response is rewritten to the path the agent knows before it is returned.
 */
export function toVirtualUris(value: JsonValue, paths: PathView): JsonValue {
  if (!paths.mount) return value
  return rewrite(value, paths)
}

function rewrite(value: JsonValue, paths: PathView): JsonValue {
  if (typeof value === 'string') return virtualUri(value, paths)
  if (Array.isArray(value)) return value.map(item => rewrite(item, paths))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [virtualUri(key, paths), rewrite(item, paths)]))
  }
  return value
}

function virtualUri(value: string, paths: PathView): string {
  if (!value.startsWith('file://')) return value
  try {
    return pathToFileURL(paths.toVirtual(fileURLToPath(value))).href
  } catch {
    // A `file://` URI that names no local path, a UNC share among them, has nothing to hide.
    return value
  }
}
