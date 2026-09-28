import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { PACKAGE_ROOT } from './sources.js'

export interface ServedRoute { method: string; path: string }

const SUFFIX = /\.(?<method>connect|delete|get|head|options|patch|post|put|trace)$/

/**
 * The file routes of the given layers, as Nitro scans them (scripts/check-duplicate-routes.mjs):
 * [name] is a parameter, [...name] a catch-all, and a method suffix narrows the method.
 */
export function layerRoutes(layers: readonly string[] = ['common', 'mcp', 'admin']): ServedRoute[] {
  return layers.flatMap((layer) => {
    const base = join(PACKAGE_ROOT, 'layers', layer, 'server', 'routes')
    return files(base).map(file => routeOf(relative(base, file).split(sep).join('/')))
  })
}

function routeOf(file: string): ServedRoute {
  const bare = file.replace(/\.ts$/, '')
  const method = SUFFIX.exec(bare)?.groups?.method?.toUpperCase() ?? 'ALL'
  const path = `/${bare.replace(SUFFIX, '').replace(/\[\.\.\.[^\]]+\]/g, '**').replace(/\[([^\]]+)\]/g, ':$1').replace(/\/index$/, '')}`
  return { method, path }
}

function files(directory: string): string[] {
  try {
    return readdirSync(directory).flatMap((name) => {
      const path = join(directory, name)
      return statSync(path).isDirectory() ? files(path) : [path]
    })
  } catch {
    return []
  }
}
