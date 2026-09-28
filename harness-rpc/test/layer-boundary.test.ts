import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PACKAGE_ROOT, sourceFiles } from './support/sources.js'

// Plan section B, copying Foundation check F54. What Nitro bundles into .output (the layers' server
// code, the custom entry and the error handler) takes values from these packages only, and common
// code as types only; everything else arrives through event.context.services. A second bundled copy
// of common would pull node-pty and dynamic plugin imports into .output, and split error identity.
// srvx is the entry's alone: it adapts the app to node:http (review L9 of B15-B17).
const LAYER_PACKAGES = /^(?:h3|nitro)(?:\/|$)|^@5straps\/(?:runtime|protocol)(?:\/|$)|^zod$/
const ENTRY_PACKAGES = /^srvx\/node$/
const FRAMEWORK = /^(?:nitro|h3|srvx|crossws|hono|@hono\/)/
const IMPORT = /\b(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g
// A dynamic import pulls a value in just as a static one does, and the bundler would inline its target (review L6 of B13-B14).
const DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g

interface Import { file: string; specifier: string; typeOnly: boolean }

function importsIn(text: string, file: string): Import[] {
  const statics = [...text.matchAll(IMPORT)].map(match => ({ file, specifier: match[3]!, typeOnly: match[2] !== undefined }))
  const dynamics = [...text.matchAll(DYNAMIC_IMPORT)].map(match => ({ file, specifier: match[1]!, typeOnly: false }))
  return [...statics, ...dynamics]
}

function importsOf(file: string): Import[] {
  return importsIn(readFileSync(file, 'utf8'), relative(PACKAGE_ROOT, file))
}

function target(item: Import): string {
  return relative(PACKAGE_ROOT, join(dirname(join(PACKAGE_ROOT, item.file)), item.specifier)).replace(/\.js$/, '.ts')
}

function bundledSources(): string[] {
  const layers = sourceFiles('layers').filter(file => relative(PACKAGE_ROOT, file).split('/')[2] === 'server')
  return [...layers, join(PACKAGE_ROOT, 'server', 'entry.ts'), join(PACKAGE_ROOT, 'server', 'error.ts')]
}

describe('the layer boundary', () => {
  it('reads dynamic imports as value imports', () => {
    const found = importsIn("const common = await import('../../../../common/runtime/services.js')\nimport type { X } from './x.js'", 'layers/common/server/routes/probe.ts')
    expect(found).toEqual(expect.arrayContaining([
      { file: 'layers/common/server/routes/probe.ts', specifier: '../../../../common/runtime/services.js', typeOnly: false },
      { file: 'layers/common/server/routes/probe.ts', specifier: './x.js', typeOnly: true },
    ]))
  })

  it('bundles only h3, nitro, @5straps/runtime, @5straps/protocol and zod from the layers, and srvx/node from the entry alone', () => {
    const packages = bundledSources().flatMap(importsOf).filter(item => !item.specifier.startsWith('.'))
    expect(packages.length).toBeGreaterThan(0)
    const allowed = (item: Import) => LAYER_PACKAGES.test(item.specifier) || item.file === 'server/entry.ts' && ENTRY_PACKAGES.test(item.specifier)
    expect(packages.filter(item => !allowed(item))).toEqual([])
    expect(LAYER_PACKAGES.test('srvx')).toBe(false)
  })

  it('takes common code as types only, and nothing from cli, mcp or the server setup', () => {
    const relatives = bundledSources().flatMap(importsOf).filter(item => item.specifier.startsWith('.'))
    const outside = relatives.filter(item => !/^(?:layers|server\/(?:entry|error|built-entry))/.test(target(item)))
    expect(outside.length).toBeGreaterThan(0)
    expect(outside.filter(item => !item.typeOnly || !target(item).startsWith('common/'))).toEqual([])
  })

  it('keeps Nitro, H3 and the HTTP faces out of common, mcp and cli', () => {
    const rules: Array<{ folder: string; reaches: RegExp }> = [
      { folder: 'common', reaches: /^common\// },
      { folder: 'mcp', reaches: /^(?:mcp|common)\// },
      { folder: 'cli', reaches: /^(?:cli|common|mcp)\// },
    ]
    for (const { folder, reaches } of rules) {
      const imports = sourceFiles(folder).flatMap(importsOf)
      expect(imports.filter(item => FRAMEWORK.test(item.specifier)), folder).toEqual([])
      expect(imports.filter(item => item.specifier.startsWith('.') && !reaches.test(target(item))), folder).toEqual([])
    }
  })

  it('asks nobody from a route: questions go through the approval service, never event.context.requestCli (review L7 of B13-B14)', () => {
    const readers = bundledSources().filter(file => /\brequestCli\b/.test(readFileSync(file, 'utf8')))
    expect(readers.map(file => relative(PACKAGE_ROOT, file))).toEqual([])
  })

  it('keeps no module-level mutable state in a layer: per-workspace handlers and caches live in services (plan section B)', () => {
    // A declaration at column 0 that can change after load: let or var, or a collection held in a const.
    const MUTABLE = /^(?:export\s+)?(?:let|var)\s|^(?:export\s+)?const\s+\w+\s*(?::[^=]+)?=\s*(?:new\s+(?:Map|Set|WeakMap|WeakSet)\b|\[)/m
    const layers = sourceFiles('layers')
    expect(layers.length).toBeGreaterThan(30)
    expect(layers.filter(file => MUTABLE.test(readFileSync(file, 'utf8'))).map(file => relative(PACKAGE_ROOT, file))).toEqual([])
    expect(MUTABLE.test('const handlers = new Map<string, unknown>()')).toBe(true)
    expect(MUTABLE.test('let cached: string | undefined')).toBe(true)
    expect(MUTABLE.test('const LIMIT = 1_024')).toBe(false)
  })

  it('has no scanned middleware: guards and audit run inside each handler (layers.md, Security boundaries)', () => {
    const layers = readdirSync(join(PACKAGE_ROOT, 'layers'))
    expect(layers.sort()).toEqual(['admin', 'common', 'mcp'])
    expect(layers.filter(layer => existsSync(join(PACKAGE_ROOT, 'layers', layer, 'server', 'middleware')))).toEqual([])
  })

  it('has no Hono anywhere in Buckle: no import in any source, script or test, and no dependency (B18 cut-over)', () => {
    const imports = sourceFiles('main.ts', 'nitro.config.ts', 'common', 'cli', 'mcp', 'server', 'layers', 'scripts', 'test').flatMap(importsOf)
    expect(imports.length).toBeGreaterThan(500)
    expect(imports.filter(item => /^(?:hono|@hono\/)/.test(item.specifier))).toEqual([])
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>
    const dependencies = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap(field => Object.keys(manifest[field] ?? {}))
    expect(dependencies.filter(name => /^(?:hono|@hono\/)/.test(name))).toEqual([])
    expect(existsSync(join(PACKAGE_ROOT, 'server', 'hono'))).toBe(false)
  })

  it('guards every route: a one-line re-export of a guarded route, or one of the four guarded handler builders; only the health routes are open (review M2 of B15-B17)', () => {
    const routes = routeFiles()
    expect(routes.length).toBeGreaterThan(80)
    const open = routes.filter(file => OPEN_ROUTES.includes(file))
    expect(open.sort()).toEqual([...OPEN_ROUTES].sort())
    const unguarded = routes.filter(file => !OPEN_ROUTES.includes(file) && !isGuarded(file))
    expect(unguarded).toEqual([])
  })

  it('gives each guarded builder its credential guard, run inside the handler after readiness', () => {
    const utils = (file: string) => readFileSync(join(PACKAGE_ROOT, file), 'utf8')
    expect(utils('layers/common/server/utils/operation.ts')).toMatch(/return defineGuardedHandler\(\{\s*guards: definition\.guards,/)
    expect(utils('layers/common/server/utils/workbench.ts')).toMatch(/defineOperationHandler\(\{\s*guards: \[requireWorkbench\],/)
    expect(utils('layers/admin/server/utils/setup.ts').match(/guards: \[[^\]]*requireAdmin\(/g)).toHaveLength(2)
  })

  it('names the workspace parameter [id] only as routes/workspaces/[id]/, so the registry routes stay node-admin only (review L5 of B15-B17)', () => {
    const misplaced = routeFiles().filter(file => /\[id\]/.test(file) && !/^layers\/\w+\/server\/routes\/workspaces\/\[id\]\//.test(file))
    expect(misplaced).toEqual([])
    const registry = routeFiles().filter(file => /\/routes\/setup\/(?:workspaces|directories)\b/.test(file))
    expect(registry.length).toBe(10)
    expect(registry.filter(file => !/export default defineRegistryHandler\(/.test(readFileSync(join(PACKAGE_ROOT, file), 'utf8')))).toEqual([])
  })
})

const OPEN_ROUTES = ['layers/common/server/routes/health.get.ts', 'layers/common/server/routes/health/ready.get.ts']
const GUARDED_BUILDER = /^export default define(Operation|Workbench|Setup|Registry)Handler\(/m
const RE_EXPORT = /^(?:\s*\/\/[^\n]*\n)*\s*export \{ default \} from '([^']+)'\s*$/

function routeFiles(): string[] {
  return sourceFiles('layers').map(file => relative(PACKAGE_ROOT, file)).filter(file => /^layers\/\w+\/server\/routes\//.test(file))
}

/** A route file answers only through a guarded builder: its own call, or the one route it re-exports. */
function isGuarded(file: string): boolean {
  const text = readFileSync(join(PACKAGE_ROOT, file), 'utf8')
  const reExport = RE_EXPORT.exec(text)
  if (reExport) {
    const target = relative(PACKAGE_ROOT, join(dirname(join(PACKAGE_ROOT, file)), reExport[1]!)).replace(/\.js$/, '.ts')
    return existsSync(join(PACKAGE_ROOT, target)) && !OPEN_ROUTES.includes(target) && !RE_EXPORT.test(readFileSync(join(PACKAGE_ROOT, target), 'utf8')) && isGuarded(target)
  }
  const builder = GUARDED_BUILDER.exec(text)?.[1]
  if (!builder) return false
  // The operation builder takes its guards from the route: one of them must be the agent credential.
  return builder !== 'Operation' || /guards: \[[^\]]*\brequireAgent\(/.test(text)
}
