import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { PACKAGE_ROOT, SCAN_EXTENSION, sourceFiles } from './support/sources.js'

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

// The scans read the source tree synchronously, and under CI they run beside the other suites, so each gets a minute.
describe('the layer boundary', { timeout: 60_000 }, () => {
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

  it('serves handlers from server/routes only: no api, middleware, tasks or modules directory in a layer, and only the listed plugins; guards and audit run inside each handler (layers.md, Security boundaries; review M3 of B18-B19, M6 of B20-B22)', () => {
    // Nitro scans api/ (under /api), middleware/, plugins/, tasks/ and modules/ in every scan dir besides routes/.
    const layers = readdirSync(join(PACKAGE_ROOT, 'layers'))
    expect(layers.sort()).toEqual(['admin', 'common', 'mcp'])
    const scanned = layers.flatMap(layer => readdirSync(join(PACKAGE_ROOT, 'layers', layer, 'server')).map(entry => `${layer}/${entry}`))
    expect(scanned.filter(entry => !SERVER_ENTRIES.includes(entry.split('/')[1]!))).toEqual([])
    // Every source Nitro would scan, by its own extensions, sits in one of those folders.
    const sources = sourceFiles('layers').map(file => relative(PACKAGE_ROOT, file)).filter(file => file.split('/')[2] === 'server')
    expect(sources.length).toBeGreaterThan(80)
    expect(sources.filter(file => !SERVER_ENTRIES.includes(file.split('/')[3]!))).toEqual([])
    // Any file at all in a plugins folder counts, whatever its extension: only the three listed ones may be there.
    const plugins = layers.flatMap(layer => filesUnder(join('layers', layer, 'server', 'plugins')))
    expect(plugins.sort()).toEqual(PLUGINS)
    expect(SCAN_EXTENSION.test('x.tsx') && SCAN_EXTENSION.test('x.cts') && SCAN_EXTENSION.test('x.cjs') && SCAN_EXTENSION.test('x.jsx')).toBe(true)
  })

  it('registers no handler, route rule, plugin or module through Nitro config: each config, as Nitro loads it, holds exactly its allowed keys, and no other config source exists (review M3 of B18-B19, M6 of B20-B22)', async () => {
    // c12 also reads nitro.config.* in any supported extension, .config/nitro.*, and .nitrorc beside each config.
    for (const directory of ['.', ...readdirSync(join(PACKAGE_ROOT, 'layers')).map(layer => `layers/${layer}`)]) {
      const sources = readdirSync(join(PACKAGE_ROOT, directory)).filter(name => /^(?:nitro\.config\.|\.nitrorc|\.config$)/.test(name))
      expect(sources, directory).toEqual(['nitro.config.ts'])
    }
    const root = await configAt('nitro.config.ts')
    expect(Reflect.ownKeys(root).sort()).toEqual(['entry', 'errorHandler', 'extends', 'preset', 'rolldownConfig', 'serverDir', 'serverEntry'])
    expect(root).toStrictEqual({
      preset: 'node_middleware',
      entry: './server/entry.ts',
      serverEntry: false,
      serverDir: false,
      errorHandler: './server/error.ts',
      extends: ['./layers/common', './layers/mcp', './layers/admin'],
      // Code mode's VM, installed with the package and read from there (owner decision D82).
      rolldownConfig: { external: [/^@5straps\//, /^@modelcontextprotocol\//, /^zod(\/|$)/, /^h3(\/|$)/, /^@earendil-works\/pi-codemode(\/|$)/, /^quickjs-wasi(\/|$)/] },
    })
    expect(Reflect.ownKeys(root.rolldownConfig as object)).toEqual(['external'])
    for (const layer of readdirSync(join(PACKAGE_ROOT, 'layers'))) {
      const config = await configAt(`layers/${layer}/nitro.config.ts`)
      expect(Reflect.ownKeys(config), layer).toEqual(['scanDirs'])
      expect(config, layer).toStrictEqual({ scanDirs: [join(PACKAGE_ROOT, 'layers', layer, 'server')] })
    }
  })

  it('leaves h3 and Nitro internals to two files: only 20.head.ts reaches the app\'s ~findRoute (or any ~ member, or nitroApp.h3), and only server/entry.ts imports nitro/app (review L10 of B20-B22)', () => {
    const sources = sourceFiles('main.ts', 'common', 'cli', 'mcp', 'server', 'layers').map(file => relative(PACKAGE_ROOT, file))
    const touching = (pattern: RegExp) => sources.filter(file => pattern.test(withoutComments(readFileSync(join(PACKAGE_ROOT, file), 'utf8')))).sort()
    expect(touching(/['"`]~[A-Za-z]|\.h3\b/)).toEqual(['layers/common/server/plugins/20.head.ts'])
    const head = withoutComments(readFileSync(join(PACKAGE_ROOT, 'layers/common/server/plugins/20.head.ts'), 'utf8'))
    expect([...new Set(head.match(/~[A-Za-z]\w*/g))]).toEqual(['~findRoute'])
    const internals = sources.flatMap(importsOf).filter(item => !item.typeOnly && /^(?:nitro\/|#nitro|h3\/)/.test(item.specifier))
    expect(internals).toEqual([{ file: 'server/entry.ts', specifier: 'nitro/app', typeOnly: false }])
    expect(readFileSync(join(PACKAGE_ROOT, 'server/entry.ts'), 'utf8')).toMatch(/^import \{ useNitroApp \} from 'nitro\/app'$/m)
    // Review L7 of B23-B25: an event reaches the app, or the matched route's handler, through neither.
    expect(touching(/\bevent\.app\b|\.app\s*\.\s*handler\b|matchedRoute\s*\??\.\s*handler\b|\[\s*['"`]handler['"`]\s*\]/)).toEqual([])
    // Review item 21 of the proof-of-possession fixes, L11 of the second re-review and L8: a tripwire, not a proof.
    // It flags the spellings appWrites lists and the rows below exercise; any other write (an alias, a computed
    // name, deeper nesting) is caught at run time, where 20.head.ts locks the app and its routes and guard-sweep
    // compares them before and after every request.
    // The head plugin's ~findRoute wrapper and its lock are the only writes, and ~findRoute the one ~ member above.
    const writes = sources.flatMap(file => appWrites(withoutComments(readFileSync(join(PACKAGE_ROOT, file), 'utf8'))).map(write => `${file}: ${write}`))
    expect(writes).toEqual([
      `layers/common/server/plugins/20.head.ts: app['~findRoute'] =`,
      'layers/common/server/plugins/20.head.ts: Object.defineProperty(app',
      'layers/common/server/plugins/20.head.ts: Object.defineProperty(app',
    ])
    const evasions = ['const { app } = event', 'app.handler = wrapped', `app['handler'] = wrapped`, 'app.handler ??= wrapped', 'Object.assign(matchedRoute, { handler })',
      `Object.defineProperty(event.context.matchedRoute, 'handler', {})`, 'event.context.matchedRoute.handler = wrapped', 'const { matchedRoute: route } = event.context',
      'app.config.onRequest = wrapped', `app.config['onRequest'] = wrapped`, 'app.config.onRequest ||= wrapped', 'Object.assign(app.config, { onRequest })',
      `Object.getPrototypeOf(app)['~request'] = wrapped`, 'app.constructor.prototype.handler = wrapped', 'app.__proto__.fetch = wrapped', 'H3Core.prototype.fetch = wrapped',
      `Object.defineProperty(Object.getPrototypeOf(app), 'fetch', {})`, `Reflect.set(Object.getPrototypeOf(app), 'fetch', wrapped)`,
      // Review L8: the spellings the comment claimed and the scan missed.
      '(app).handler = wrapped', '(app.config).onRequest = wrapped', '[app.handler] = [wrapped]', 'for (app.handler of handlers) run()',
      `event.context['matchedRoute'].handler = wrapped`, 'Object.getPrototypeOf(Object.getPrototypeOf(app)).fetch = wrapped', 'app.hits++', '--app.config.depth',
      // Review L9 of the continuation review: one-level array destructuring whose target carries a bracket index.
      `[app['handler']] = [wrapped]`, `[other, app.config['onRequest']] = pair`]
    expect(evasions.filter(evasion => appWrites(evasion).length === 0)).toEqual([])
    expect(appWrites('if (app.handler === wrapped) run(app, matchedRoute)')).toEqual([])
    expect(appWrites('const routes = [app.handler, other]; for (const handler of [app.handler]) run(handler, counts[app.id] + 1)')).toEqual([])
    expect(appWrites('if (Object.getPrototypeOf(app).fetch === wrapped && app.config.onRequest !== undefined) run(app.config)')).toEqual([])
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

  it('guards every route: a one-line re-export of a guarded route, or one of the five guarded handler builders; only the health routes are open (review M2 of B15-B17)', () => {
    const routes = routeFiles()
    expect(routes.length).toBeGreaterThan(80)
    const open = routes.filter(file => OPEN_ROUTES.includes(file))
    expect(open.sort()).toEqual([...OPEN_ROUTES].sort())
    const unguarded = routes.filter(file => !OPEN_ROUTES.includes(file) && !isGuarded(file))
    expect(unguarded).toEqual([])
  })

  it('gives each guarded builder its credential guard, run inside the handler after readiness', () => {
    const utils = (file: string) => readFileSync(join(PACKAGE_ROOT, file), 'utf8')
    expect(utils('layers/common/server/utils/operation.ts')).toMatch(/return defineGuardedHandler\(\{\s*\.\.\.\(definition\.preflight \? \{ preflight: definition\.preflight \} : \{\}\),\s*guards: definition\.guards,/)
    expect(utils('layers/common/server/utils/workbench.ts')).toMatch(/defineOperationHandler\(\{\s*guards: \[requireWorkbench\],/)
    const setup = utils('layers/admin/server/utils/setup.ts')
    expect(setup.match(/guards: \[[^\]]*requireAdmin\(/g)).toHaveLength(2)
    // The experimental flag, then a node without BUCKLE_ADMIN_TOKEN, answer before readiness on both admin builders (review L9 of B23-B25, item 23).
    expect(setup.match(/preflight: \[requireAdminHttp, requireNodeAdminCredential\],/g)).toHaveLength(2)
    for (const [name, scope] of [['defineSetupHandler', 'WorkspaceSetupScope'], ['defineSetupSessionHandler', 'SetupScope']] as const) {
      const body = setup.split('export function ' + name + '(')[1]?.split(/^(?:export )?(?:async )?function /m)[0] ?? ''
      expect(body, name).toContain('return defineSetupOperation<' + scope + '>(definition,')
    }
    const operation = setup.split('function defineSetupOperation<')[1]?.split(/^(?:export )?(?:async )?function /m)[0] ?? ''
    expect(operation).toMatch(/return defineOperationHandler\(\{\s*preflight: \[requireAdminHttp, requireNodeAdminCredential\],\s*guards: \[event => requireAdmin\(accessOf\(event\), SETUP_REFUSED\)\(event\)\],/)
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
/** What a layer's server directory may hold: Nitro scans only routes/ and plugins/ of these. */
const SERVER_ENTRIES = ['routes', 'plugins', 'utils', 'types']
const PLUGINS = ['layers/common/server/plugins/10.context.ts', 'layers/common/server/plugins/20.head.ts', 'layers/common/server/plugins/30.request-log.ts']
const GUARDED_BUILDER = /^export default define(Operation|Workbench|Setup|SetupSession|Registry)Handler\(/m
const RE_EXPORT = /^(?:\s*\/\/[^\n]*\n)*\s*export \{ default \} from '([^']+)'\s*$/

// Flags direct member/index writes, simple destructuring (an array target may carry one bracket index, as in
// `[app['handler']] = [w]`) and loop targets, and the Object/Reflect mutations below. Complete parenthesised targets,
// nested destructuring (`({ a: { b: app.x } } = o)`, `[[app.x]] = [[w]]`), an array target with a bracket index
// inside a bracket index, TypeScript assertions and aliases can escape this scan (review L9 of the continuation review).
// 20.head.ts locks app config, methods, lists and matched route data; h3 dispatcher fields remain mutable.
function appWrites(text: string): string[] {
  const target = String.raw`(?:\b(?:app|matchedRoute)\b|\[\s*['"\`](?:app|matchedRoute)['"\`]\s*\])`
  const prototype = String.raw`(?:\.\s*prototype\b|\b__proto__\b|\bgetPrototypeOf\s*\((?:[^()]|\([^()]*\))*\))`
  const members = String.raw`(?:\s*(?:\?\.|\.)\s*[\w$~]+|\s*\[[^\]]*\])`
  const assigned = String.raw`\s*(?:[-+*/%&|^]|\?\?|&&|\|\||<<|>>>?|\*\*)?=(?![=>])`
  const written = String.raw`(?:${target}|\(\s*${target}${members}*\s*\)|${prototype})${members}+`
  const patterns = [
    new RegExp(String.raw`${written}${assigned}`, 'g'),
    new RegExp(String.raw`${written}\s*(?:\+\+|--)|(?:\+\+|--)\s*${written}`, 'g'),
    new RegExp(String.raw`\{[^{}]*${target}[^{}]*\}\s*=(?![=>])`, 'g'),
    new RegExp(String.raw`(?<![\w$\])])\s*\[(?:[^\[\]]|\[[^\[\]]*\])*${target}(?:[^\[\]]|\[[^\[\]]*\])*\]\s*=(?![=>])`, 'g'),
    new RegExp(String.raw`\bfor\s*(?:await\s*)?\(\s*${written}\s+(?:of|in)\b`, 'g'),
    new RegExp(String.raw`\b(?:Object\.(?:assign|defineProperty|defineProperties|setPrototypeOf)|Reflect\.(?:set|defineProperty|setPrototypeOf))\s*\(\s*[\w$.?\[\]'"\`~(]*(?:${target}|${prototype})`, 'g'),
  ]
  return patterns.flatMap(pattern => [...text.matchAll(pattern)].map(match => match[0].replace(/\s+/g, ' ').trim()))
}

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** Every file under a package-relative directory, any extension, package-relative; none when it is absent. */
function filesUnder(directory: string): string[] {
  if (!existsSync(join(PACKAGE_ROOT, directory))) return []
  return readdirSync(join(PACKAGE_ROOT, directory), { recursive: true, encoding: 'utf8' })
    .map(path => join(directory, path))
    .filter(path => statSync(join(PACKAGE_ROOT, path)).isFile())
}

/** A Nitro config as Nitro loads it: the module's default export, fresh from disk. */
async function configAt(file: string): Promise<Record<string | symbol, unknown>> {
  vi.resetModules()
  const config = (await import(pathToFileURL(join(PACKAGE_ROOT, file)).href) as { default: unknown }).default
  expect(typeof config, file).toBe('object')
  return config as Record<string | symbol, unknown>
}

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
