import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as runtime from '@5straps/runtime'
import { NitroErrorCode, registerCliListener, useHost } from '@5straps/runtime/nitro'
import { afterEach, describe, expect, inject, it, vi } from 'vitest'
import { createBuckleHttp, type BuckleHttp } from '../support/buckle-http.js'
import { layerRoutes } from '../support/routes.js'

const build = inject('buckleBuild')
const nodes: BuckleHttp[] = []
afterEach(async () => { for (const node of nodes.splice(0)) await node.close() })

function environment(extra: Record<string, string> = {}): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), 'buckle-http-build-'))
  mkdirSync(join(root, 'workspace'))
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  return { BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_AUTH_TOKEN: 'build-agent-token', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', ...extra }
}

async function node(input: { headless?: boolean; environment?: Record<string, string> } = {}): Promise<BuckleHttp> {
  const started = await createBuckleHttp({ environment: input.environment ?? environment(), ...(input.headless ? { headless: true } : {}) })
  nodes.push(started)
  return started
}

function files(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' }).map(path => join(directory, path)).filter(path => statSync(path).isFile())
}

// Strings that exist only in Buckle's common code or inside @5straps/runtime: finding one in .output
// would mean a second copy was bundled instead of imported (Buckle phase plan, section B).
const BUNDLED_ELSEWHERE = [
  'This process already has its requester bound',
  'Approval was declined',
  'Workspace is disabled or retired',
  'A cli:call listener is already registered',
  'No operation scope is active',
]

describe('the built server (.output)', () => {
  it('has the custom entry and no native addon, with and without the admin layer', () => {
    for (const output of Object.values(build.outputs)) {
      expect(statSync(join(output, 'server', 'index.mjs')).isFile()).toBe(true)
      expect(files(output).filter(path => path.endsWith('.node'))).toEqual([])
    }
  })

  it('checks for markers that do exist: each is in the built common code or the runtime it imports (review L3 of B13-B14)', () => {
    const runtimeDist = dirname(createRequire(build.entries.full).resolve('@5straps/runtime'))
    const elsewhere = [...files(join(build.root, 'dist', 'common')), ...files(runtimeDist)].filter(path => path.endsWith('.js')).map(path => readFileSync(path, 'utf8'))
    expect(BUNDLED_ELSEWHERE.filter(marker => !elsewhere.some(text => text.includes(marker)))).toEqual([])
  })

  it('bundles neither common nor the runtime: route chunks import @5straps/runtime bare', () => {
    const built = files(build.outputs.full).filter(path => path.endsWith('.mjs'))
    for (const path of built) {
      const text = readFileSync(path, 'utf8')
      expect(BUNDLED_ELSEWHERE.filter(marker => text.includes(marker)), relative(build.root, path)).toEqual([])
    }
    expect(readFileSync(join(build.outputs.full, 'server', '_routes', 'health', 'ready.mjs'), 'utf8')).toMatch(/from "@5straps\/runtime\/nitro"/)
    expect(readFileSync(join(build.outputs.full, 'server', 'index.mjs'), 'utf8')).toMatch(/from "@5straps\/runtime"/)
  })

  it('shares one @5straps/runtime with main: the app resolves the module this process runs', async () => {
    const resolved = createRequire(build.entries.full).resolve('@5straps/runtime')
    expect(await import(pathToFileURL(resolved).href)).toBe(runtime)
  })

  it('takes exactly one cli:call listener: main\'s, and a second is refused until it is released', async () => {
    const buckle = await node()
    const second = () => registerCliListener(buckle.nitroApp, async () => {})
    expect(second).toThrow(expect.objectContaining({ code: NitroErrorCode.cliListenerRegistered }))
    await buckle.close()
    second()()
  })

  it('gives the app\'s host the process requester, with the pending-approval fallback (review L7 of B13-B14)', async () => {
    const buckle = await node()
    expect(useHost(buckle.nitroApp)?.requestCli).toBe(buckle.requestCli)
    const question = { id: 'approval:default:t1', kind: 'approval', correlationId: 'c1', target: 'default', action: { summary: 'probe', details: { approve: 'buckle approve t1' } }, wait: { mode: 'finite', timeoutMs: 1_000 } } as const
    await buckle.close()
    // With the listener gone, the host's requester reports the ask as pending, never a bare unavailable.
    expect(await buckle.requestCli(question)).toMatchObject({ status: 'unavailable', pending: { id: 'approval:default:t1', instructions: 'buckle approve t1' } })
  })

  it('reports ready once started, shutting down while it closes, and not ready again once closed', async () => {
    const buckle = await node()
    expect((await buckle.request('/health/ready')).status).toBe(200)
    const held = Promise.withResolvers<void>()
    buckle.common.owner.onClose('waiters', 'held by the test', () => held.promise)
    const closing = buckle.close()
    const shuttingDown = await buckle.request('/health/ready')
    expect(shuttingDown.status).toBe(503)
    expect(await shuttingDown.json()).toEqual({ error: 'Runtime is shutting down' })
    held.resolve()
    await closing
    const closed = await buckle.nitroApp.fetch(new Request('http://127.0.0.1/health/ready'))
    expect(closed.status).toBe(503)
    expect(await closed.json()).toEqual({ error: 'Runtime is not attached to this request' })
  })

  it('leaves the admin layer out of the build config under --no-admin', async () => {
    const config = async (admin: string) => {
      vi.stubEnv('BUCKLE_BUILD_ADMIN_LAYER', admin)
      vi.resetModules()
      try { return (await import('../../nitro.config.js')).default } finally { vi.unstubAllEnvs() }
    }
    expect((await config('false')).extends).toEqual(['./layers/common', './layers/mcp'])
    expect((await config('true')).extends).toEqual(['./layers/common', './layers/mcp', './layers/admin'])
  })

  it('serves no /setup route from the build without the admin layer, even with an admin credential, and the full build does', async () => {
    const admin = { authorization: 'Bearer build-admin-token' }
    const headless = await node({ headless: true, environment: environment({ BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true', BUCKLE_ADMIN_TOKEN: 'build-admin-token' }) })
    for (const path of ['/setup/status', '/setup/workspaces', '/setup/x', '/workspaces/default/setup/status']) {
      const setup = await headless.request(path, { headers: admin })
      expect(setup.status, path).toBe(path.startsWith('/workspaces/') ? 401 : 404)
    }
    expect((await headless.request('/health')).status).toBe(200)
    await headless.close()

    // The positive control (review L3 of B13-B14): the same credential opens the full build's face.
    const full = await node({ environment: environment({ BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true', BUCKLE_ADMIN_TOKEN: 'build-admin-token' }) })
    expect((await full.request('/setup/status', { headers: admin })).status).toBe(200)
    expect((await full.request('/workspaces/default/setup/status', { headers: admin })).status).toBe(200)
  })

  it('compiles exactly the layers\' file routes, and no middleware, into the router: every handler entry parsed, meta or not (review M3 of B18-B19, M6 of B20-B22)', () => {
    const table = (routes: Array<{ method: string; path: string }>) => routes.map(route => `${route.method} ${route.path}`).sort()
    expect(table(compiledRoutes(build.outputs.full))).toEqual(table(layerRoutes()))
    expect(table(compiledRoutes(build.outputs.headless))).toEqual(table(layerRoutes(['common', 'mcp'])))
    for (const output of Object.values(build.outputs)) {
      const router = compiledRouter(output)
      expect(router.match(/\bhandler:/g)?.length, output).toBe(compiledRoutes(output).length)
      expect(router, output).not.toContain('multiHandler(')
      expect(readFileSync(join(output, 'server', 'index.mjs'), 'utf8')).not.toContain('["~middleware"]')
    }
    // Positive control: an entry Nitro writes with meta between method and handler is parsed.
    expect(parseRoutes('{\n route: "/x/**:rest",\n method: "get",\n meta: {"openAPI":{"tags":["a,b"]}},\n handler: _lazy_1\n}')).toEqual([{ method: 'GET', path: '/x/**' }])
  })

  it('compiles exactly the three listed plugins into the app, and nothing else as a plugin (review M6 of B20-B22)', () => {
    for (const output of Object.values(build.outputs)) {
      const entry = readFileSync(join(output, 'server', 'index.mjs'), 'utf8')
      const regions = [...new Set([...entry.matchAll(/^\/\/#region (\S*\/plugins\/\S+)$/gm)].map(match => match[1]!))].sort()
      expect(regions, output).toEqual(['layers/common/server/plugins/10.context.ts', 'layers/common/server/plugins/20.head.ts', 'layers/common/server/plugins/30.request-log.ts'])
      expect(topLevelEntries(compiledPlugins(entry)), output).toBe(3)
    }
    expect(topLevelEntries('\n\ta,\n\tf((x) => { g("],"); }, [1, 2]),\n\t`${"]"}`\n')).toBe(3)
  })

  it('records every package it bundled from node_modules or that generated code into it, and none of the externals, in bundled-packages.json (B21)', () => {
    for (const output of Object.values(build.outputs)) {
      const bundled = JSON.parse(readFileSync(join(output, 'bundled-packages.json'), 'utf8')) as string[]
      expect(bundled).toEqual([...bundled].sort())
      // rou3 compiled the router into the entry at build time: listed though no module of it is bundled.
      expect(bundled).toEqual(expect.arrayContaining([expect.stringMatching(/^nitro@\d/), expect.stringMatching(/^srvx@\d/), expect.stringMatching(/^rou3@\d/)]))
      expect(bundled.filter(item => /^(?:@5straps\/|@modelcontextprotocol\/|zod@|h3@)/.test(item))).toEqual([])
      expect(bundled.every(item => /^(?:@[^/@]+\/)?[^/@]+@\d[^@]*$/.test(item))).toBe(true)
    }
  })

  it('bundles no admin route into the build without the admin layer', () => {
    const routesOf = (output: string) => files(join(output, 'server', '_routes')).map(path => relative(join(output, 'server', '_routes'), path))
    expect(routesOf(build.outputs.full).filter(path => path.startsWith('setup/'))).not.toEqual([])
    expect(routesOf(build.outputs.headless).filter(path => path.includes('setup'))).toEqual([])
    expect(readFileSync(join(build.outputs.headless, 'server', 'index.mjs'), 'utf8')).not.toContain('"/setup')
    expect(readFileSync(join(build.outputs.full, 'server', 'index.mjs'), 'utf8')).toContain('"/setup/status"')
  })
})

/** The router Nitro compiles into the entry: the `findRoute` function, up to its closing line. */
function compiledRouter(output: string): string {
  const entry = readFileSync(join(output, 'server', 'index.mjs'), 'utf8')
  const start = entry.indexOf('const findRoute = ')
  const end = entry.indexOf('\n})();', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return entry.slice(start, end)
}

/** Each handler's route and method ('ALL' when it has none), catch-alls as `**`. */
function compiledRoutes(output: string): Array<{ method: string; path: string }> {
  return parseRoutes(compiledRouter(output))
}

/** Nitro writes each entry as route, then method and meta when set, then handler (serializeHandler in nitro's build). */
function parseRoutes(router: string): Array<{ method: string; path: string }> {
  const routes = [...router.matchAll(/\{\s*route: "([^"]+)",(?:\s*method: "(\w+)",)?(?:\s*meta: [\s\S]*?,)?\s*handler:/g)]
  return routes.map(match => ({ method: (match[2] ?? 'all').toUpperCase(), path: match[1]!.replace(/\*\*:\w+/g, '**') }))
}

/** The body of the compiled `plugins` array, the list the app runs at start. */
function compiledPlugins(entry: string): string {
  const start = entry.indexOf('const plugins = [')
  expect(start).toBeGreaterThan(-1)
  const open = start + 'const plugins = ['.length
  return entry.slice(open, open + closingIndex(entry.slice(open)))
}

/** The index of the bracket closing an array whose opening bracket came just before `text`. */
function closingIndex(text: string): number {
  let depth = 1
  for (let index = 0; index < text.length; index++) {
    const skipped = skipLiteral(text, index)
    if (skipped !== index) { index = skipped - 1; continue }
    const char = text[index]
    if (char === '[' || char === '{' || char === '(') depth++
    if (char === ']' || char === '}' || char === ')') depth--
    if (depth === 0) return index
  }
  throw new Error('The compiled plugins array has no closing bracket')
}

/** How many comma-separated entries sit at the top level of an array body. */
function topLevelEntries(body: string): number {
  let depth = 0
  let entries = body.trim() === '' ? 0 : 1
  for (let index = 0; index < body.length; index++) {
    const skipped = skipLiteral(body, index)
    if (skipped !== index) { index = skipped - 1; continue }
    const char = body[index]
    if (char === '[' || char === '{' || char === '(') depth++
    if (char === ']' || char === '}' || char === ')') depth--
    if (char === ',' && depth === 0 && body.slice(index + 1).trim() !== '') entries++
  }
  return entries
}

/** The index just past a string, template or comment starting at `index`, or `index` itself when none starts there. */
function skipLiteral(text: string, index: number): number {
  const char = text[index]
  if (text.startsWith('//', index)) return text.indexOf('\n', index) === -1 ? text.length : text.indexOf('\n', index)
  if (text.startsWith('/*', index)) return text.indexOf('*/', index + 2) + 2
  if (char !== '"' && char !== "'" && char !== '`') return index
  for (let cursor = index + 1; cursor < text.length; cursor++) {
    if (text[cursor] === '\\') { cursor++; continue }
    if (char === '`' && text.startsWith('${', cursor)) { cursor += closingIndex(text.slice(cursor + 2)) + 2; continue }
    if (text[cursor] === char) return cursor + 1
  }
  throw new Error('Unterminated literal in the compiled plugins array')
}
