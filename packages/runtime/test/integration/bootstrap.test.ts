import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { CLOSE_STAGES } from '../../src/index.js'
import { acquireFileLock } from '../../src/sqlite/index.js'
import { bearer, createDataDir, createTokens, expectCleanDiagnostics, fixtureEnv, runFixtureCli, serveFixture, startFixture, startupGate, stopAll, type FixtureProcess, type LogLine } from './support/fixture-process.js'
import { fixtureRoot, packageRoot } from './support/paths.js'
import { startHuman, type Human } from './support/human.js'
import { expectNoLeakedResources, resourceSnapshot } from './support/resources.js'

const run = promisify(execFile)
const build = inject('fixtureBuild')
const tokens = createTokens()
const started: FixtureProcess[] = []
const humans: Human[] = []
let resourcesBefore: Record<string, number>

beforeAll(() => { resourcesBefore = resourceSnapshot() })
afterAll(async () => {
  await stopAll(started)
  await Promise.all(humans.map(human => human.close()))
  for (const fixture of started) expectCleanDiagnostics(fixture)
  await expectNoLeakedResources(resourcesBefore)
})

async function serve(input: { entry?: string; dataDir?: string; extra?: Record<string, string> } = {}) {
  const fixture = await serveFixture({ entry: input.entry ?? build.full.entry, dataDir: input.dataDir ?? createDataDir(), tokens, extra: input.extra })
  started.push(fixture)
  return fixture
}

async function ready<T extends FixtureProcess>(fixture: T): Promise<T> {
  await fixture.waitFor('common ready')
  return fixture
}

function messages(events: LogLine[], names: readonly string[]): string[] {
  return events.map(event => event.message).filter(message => names.includes(message))
}

function outputFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' }).map(path => join(directory, path)).filter(path => statSync(path).isFile())
}

describe('F01 file routing through extended layers', () => {
  it('serves /v1 routes without /api, JSON errors for unknown paths, and method-specific files as 404 for other methods', async () => {
    const fixture = await ready(await serve())
    const health = await fetch(fixture.url('/health'))
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: 'ok' })
    expect((await fetch(fixture.url('/v1/notes'), { headers: bearer(tokens.agent) })).status).toBe(200)

    for (const path of ['/api/v1/notes', '/does-not-exist']) {
      const missing = await fetch(fixture.url(path), { headers: bearer(tokens.agent) })
      expect(missing.status).toBe(404)
      expect(missing.headers.get('content-type')).toContain('application/json')
      // routing-bootstrap-15: the body never echoes the request URL, host or port.
      expect(await missing.json()).toEqual({ error: 'Not Found' })
    }
    // Nitro file routes do not emit 405: a GET-only file answers other methods with 404.
    const wrongMethod = await fetch(fixture.url('/health'), { method: 'POST' })
    expect(wrongMethod.status).toBe(404)
    expect(await wrongMethod.json()).toEqual({ error: expect.any(String) })
  })
})

describe('F02 duplicate route registrations fail the project check', () => {
  const script = join(packageRoot, '../../scripts/check-duplicate-routes.mjs')

  // A throwaway Nitro project: files relative to its root, config as source text.
  function project(files: Record<string, string>, config: string): string {
    const root = mkdtempSync(join(tmpdir(), 'duplicate-routes-'))
    mkdirSync(join(root, 'node_modules'))
    symlinkSync(join(packageRoot, 'node_modules/nitro'), join(root, 'node_modules/nitro'), 'dir')
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true })
      writeFileSync(join(root, path), source)
    }
    writeFileSync(join(root, 'nitro.config.ts'), `export default ${config}\n`)
    return root
  }

  async function checkFails(root: string): Promise<string> {
    const failure = await run(process.execPath, [script, root]).catch((error: unknown) => error as { code: number; stderr: string })
    expect(failure).toMatchObject({ code: 1 })
    return (failure as { stderr: string }).stderr
  }

  const handler = 'export default () => "ok"\n'
  const twoLayers = '{ preset: "node_middleware", scanDirs: ["./first", "./second"] }'

  it('passes the fixture and names both files when two layers claim GET /health', async () => {
    await expect(run(process.execPath, [script, build.fixtureRoot])).resolves.toMatchObject({ stdout: expect.stringContaining('No duplicate Nitro routes') })
    const stderr = await checkFails(project({ 'first/routes/health.get.ts': handler, 'second/routes/health.ts': handler }, twoLayers))
    expect(stderr).toMatch(/GET \/health: .*first\/routes\/health\.get\.ts, .*second\/routes\/health\.ts/)
  })

  it('packaging-ci-3 fails the same way when the script is run through a symlinked path', async () => {
    const link = join(mkdtempSync(join(tmpdir(), 'routes-link-')), 'check-duplicate-routes.mjs')
    symlinkSync(script, link)
    const failure = await run(process.execPath, [link, project({ 'first/routes/health.get.ts': handler, 'second/routes/health.ts': handler }, twoLayers)]).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 1, stderr: expect.stringContaining('GET /health') })
  })

  it('packaging-ci-2 treats named and unnamed catch-alls at one prefix as the same route', async () => {
    const stderr = await checkFails(project({ 'first/routes/files/[...].get.ts': handler, 'second/routes/files/[...path].get.ts': handler }, twoLayers))
    expect(stderr).toMatch(/GET \/files\/\*\*.*first\/routes\/files\/\[\.\.\.\]\.get\.ts, .*second\/routes\/files\/\[\.\.\.path\]\.get\.ts/)
  })

  it('packaging-ci-1 scans dot directories the way Nitro does', async () => {
    const stderr = await checkFails(project({ 'first/routes/.well-known/security.get.ts': handler, 'second/routes/.well-known/security.get.ts': handler }, twoLayers))
    expect(stderr).toMatch(/GET \/\.well-known\/security: .*first.*second/)
  })

  it('routing-bootstrap-4 counts routes and handlers registered in the Nitro config', async () => {
    // Config entries are listed first: Nitro registers them ahead of scanned files, so they win.
    const routes = await checkFails(project({ 'first/routes/health.get.ts': handler, 'h.ts': handler }, '{ preset: "node_middleware", scanDirs: ["./first"], routes: { "/health": "./h.ts" } }'))
    expect(routes).toMatch(/GET \/health: .*h\.ts \(nitro config\), .*first\/routes\/health\.get\.ts/)
    const handlers = await checkFails(project({ 'first/routes/health.get.ts': handler, 'h.ts': handler }, '{ preset: "node_middleware", scanDirs: ["./first"], handlers: [{ route: "/health", method: "get", handler: "./h.ts" }] }'))
    expect(handlers).toMatch(/GET \/health: .*h\.ts \(nitro config\), .*first\/routes\/health\.get\.ts/)
  })
})

describe('F03 disabled admin layer', () => {
  it('omits /setup routes and the admin plugin from an admin:false build', async () => {
    const full = await ready(await serve())
    expect((await fetch(full.url('/setup/status'), { headers: bearer(tokens.admin) })).status).toBe(200)
    const headless = await ready(await serve({ entry: build.headless.entry }))
    const missing = await fetch(headless.url('/setup/status'), { headers: bearer(tokens.admin) })
    expect(missing.status).toBe(404)
    expect((await headless.waitFor('nitro plugins registered')).fields?.order).not.toContain('admin:marker')
    const contains = (outDir: string) => outputFiles(join(outDir, '.output')).some(path => readFileSync(path, 'utf8').includes('admin:marker'))
    expect(contains(build.full.outDir)).toBe(true)
    expect(contains(build.headless.outDir)).toBe(false)
  })
})

describe('F04 plugin order', () => {
  it('runs layer plugins in scan order with the context plugin before plugins that depend on it', async () => {
    const fixture = await serve()
    const registered = await fixture.waitFor('nitro plugins registered')
    expect(registered.fields?.order).toEqual(['common:faults-before-context', 'common:context', 'common:faults-after-context', 'admin:marker'])
  })
})

describe('F05 main-owned bootstrap', () => {
  it('initialises once, binds the host and the cli:call listener before listening, and refuses the startup window with 503', async () => {
    const gate = startupGate()
    const fixture = await serve({ extra: gate.env })
    const early = await fetch(fixture.url('/v1/notes'), { headers: bearer(tokens.agent) })
    expect(early.status).toBe(503)
    expect(await early.json()).toEqual({ error: expect.any(String) })
    gate.open()
    await fixture.waitFor('common ready')
    const statuses = await Promise.all(Array.from({ length: 20 }, () => fetch(fixture.url('/v1/notes'), { headers: bearer(tokens.agent) }).then(response => response.status)))
    expect(statuses).toEqual(Array(20).fill(200))

    const order = messages(fixture.events, ['common initialized', 'nitro plugins registered', 'host bound', 'cli listener registered', 'listening', 'common ready'])
    expect(order).toEqual(['common initialized', 'nitro plugins registered', 'host bound', 'cli listener registered', 'listening', 'common ready'])
    expect(fixture.events.filter(event => event.message === 'service created' && event.fields?.service === 'NoteService')).toHaveLength(1)
  })
})

describe('F06 no import-time startup', () => {
  it('importing the built entry or common/ opens no database, socket or timer', async () => {
    const dataDir = createDataDir()
    const env = fixtureEnv({ dataDir, tokens })
    const imported = await run(process.execPath, ['--input-type=module', '-e', 'const m = await import(process.argv[1]); if (!m.nitroApp || !m.middleware) process.exit(3)', build.full.entry], { env, timeout: 10_000 })
    expect(imported.stdout).toBe('')
    const common = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', 'await import(process.argv[1]); await import(process.argv[2])', join(build.fixtureRoot, 'common/runtime.ts'), join(build.fixtureRoot, 'mcp/server.ts')], { env, cwd: packageRoot, timeout: 10_000 })
    expect(common.stdout).toBe('')
    expect(readdirSync(dataDir)).toEqual([])
  })
})

describe('Single @5straps/runtime copy shared by main.ts and the bundle', () => {
  it('a scope opened in main is visible inside a bundled route, and no runtime source is bundled', async () => {
    const fixture = await ready(await serve())
    const probe = await (await fetch(fixture.url('/v1/scope-probe'))).json() as { correlationId: string | null; runtimeUrl: string }
    const opened = await fixture.waitFor('scope probe opened')
    expect(probe.correlationId).toBe(opened.fields?.probeId)
    expect(probe.correlationId).toMatch(/^main-probe-/)
    // routing-bootstrap-7: module identity, which the shared global ALS slots alone cannot prove.
    expect(probe.runtimeUrl).toBe(opened.fields?.runtimeUrl)
    expect(probe.runtimeUrl).toBe(pathToFileURL(join(build.root, 'node_modules/@5straps/runtime/dist/index.js')).href)
    const files = outputFiles(join(build.full.outDir, '.output'))
    expect(files.filter(path => readFileSync(path, 'utf8').includes('No operation scope is active'))).toEqual([])
    expect(readFileSync(join(build.full.outDir, '.output/server/_routes/v1/scope_probe.mjs'), 'utf8')).toMatch(/from "@5straps\/runtime"/)
  })
})

describe('F19 HTTP context propagation', () => {
  it('keeps 100 concurrent actors, their scoped services and correlation ids apart', async () => {
    const fixture = await ready(await serve())
    const results = await Promise.all(Array.from({ length: 100 }, async (_, index) => {
      const response = await fetch(fixture.url('/v1/whoami'), { headers: bearer(tokens.agent, { 'x-actor': `actor-${index}` }) })
      return { index, body: await response.json() as Record<string, unknown> }
    }))
    // Sub-actors stay under the verified credential (routing-bootstrap-13).
    const actorOf = (index: number) => `agent:actor-${index}`
    const crossovers = results.filter(({ index, body }) => body.actor !== actorOf(index) || body.alsActor !== actorOf(index) || body.serviceActor !== actorOf(index) || body.alsCorrelationId !== body.correlationId || body.serviceCorrelationId !== body.correlationId || body.sameScopedInstance !== true || body.freshTransients !== true)
    expect(new Set(results.map(({ body }) => body.correlationId)).size).toBe(100)
    expect(crossovers).toEqual([])
  })
})

describe('F20 non-HTTP scopes and background work', () => {
  it('refuses useScope outside a CLI scope and drains background work before the scope closes', async () => {
    const dataDir = createDataDir()
    const cli = await runFixtureCli({ dataDir, tokens, args: ['scope-check'] })
    expect(cli.code).toBe(0)
    expect(cli.output).toEqual({ outsideError: 'MissingScopeError', outsideSafe: null, drainedBeforeClose: true, scopeState: 'disposed' })
    expectCleanDiagnostics(cli.process)
  })

  it('runs HTTP background work inside the request scope and drains it', async () => {
    const fixture = await ready(await serve())
    const response = await fetch(fixture.url('/v1/notes'), { method: 'POST', headers: bearer(tokens.agent, { 'content-type': 'application/json' }), body: JSON.stringify({ text: 'first' }) })
    expect(response.status).toBe(201)
    const { correlationId } = await response.json() as { correlationId: string }
    const indexed = await fixture.waitFor('note indexed')
    expect(indexed.correlationId).toBe(correlationId)
  })
})

describe('F21 readiness', () => {
  it('answers liveness 200 and readiness 503 while starting, then 200 when ready', async () => {
    const gate = startupGate()
    const fixture = await serve({ extra: gate.env })
    expect((await fetch(fixture.url('/health'))).status).toBe(200)
    expect((await fetch(fixture.url('/health/ready'))).status).toBe(503)
    gate.open()
    await fixture.waitFor('common ready')
    expect((await fetch(fixture.url('/health/ready'))).status).toBe(200)
  })

  it('never runs a business handler when startup fails, then exits 1', async () => {
    const gate = startupGate()
    const fixture = await serveFixture({ entry: build.full.entry, dataDir: createDataDir(), tokens, extra: { ...gate.env, FIXTURE_STARTUP_FAILS: 'true' } })
    const during = await fetch(fixture.url('/v1/notes'), { headers: bearer(tokens.agent) })
    expect(during.status).toBe(503)
    gate.open()
    expect(await fixture.exited).toBe(1)
    expect(fixture.events.some(event => event.message === 'startup failed')).toBe(true)
    expect(fixture.events.filter(event => event.message === 'operation executed')).toEqual([])
    expect(fixture.malformed).toEqual([])
  })
})

describe('F22 close order', () => {
  it('under load: cancels the waiter durably, drains the job, ends the stream, releases the lock, then exits 0', async () => {
    const dataDir = createDataDir()
    const person = await startHuman()
    humans.push(person)
    const fixture = await ready(await serve({ dataDir, extra: { FIXTURE_TERMINAL_SOCKET: person.path } }))
    await person.connected
    const ask = fetch(fixture.url('/v1/ask'), { method: 'POST', headers: bearer(tokens.agent, { 'content-type': 'application/json' }), body: JSON.stringify({ summary: 'pending at shutdown' }) })
    const prompt = await person.waitForPrompt()
    const job = await fetch(fixture.url('/v1/notes'), { method: 'POST', headers: bearer(tokens.agent, { 'content-type': 'application/json' }), body: JSON.stringify({ text: 'indexed at shutdown', indexDelayMs: 300 }) })
    expect(job.status).toBe(201)
    const stream = (await fetch(fixture.url('/v1/stream?events=100'), { headers: bearer(tokens.agent) })).body!.getReader()
    await stream.read()

    expect(await fixture.stop('SIGTERM')).toBe(0)
    const answer = await ask
    expect(answer.status).toBe(200)
    const { outcome } = await answer.json() as { outcome: Record<string, unknown> }
    expect(outcome).toMatchObject({ status: 'unavailable', requestId: prompt.id, pending: { id: prompt.id } })
    while (!(await stream.read()).done) { /* the stream ended at shutdown */ }

    const order = fixture.events.flatMap((event) => {
      if (event.message === 'close step') return [`${String(event.fields?.stage)}:${String(event.fields?.name).replace(dataDir, '<data>')}`]
      if (event.message === 'stream ended' || event.message === 'note indexed') return [event.message]
      return []
    })
    expect(order.filter(item => item.includes(':'))).toEqual(['accept:http server', 'timers:heartbeat', 'waiters:terminal', 'waiters:cli requester', 'streams:http server connections', 'locks:ownership lock <data>/server.lock', 'services:service registry', 'databases:notes database', 'sinks:logger'])
    expect(order.indexOf('stream ended')).toBeLessThan(order.indexOf('streams:http server connections'))
    expect(order.indexOf('note indexed')).toBeLessThan(order.indexOf('databases:notes database'))
    const leftover = (fixture.events.find(event => event.message === 'active resources after close')?.fields?.resources ?? []) as string[]
    expect(leftover.filter(kind => ['Timeout', 'TCPServerWrap', 'TCPSocketWrap'].includes(kind))).toEqual([])
    const lock = await acquireFileLock({ path: join(dataDir, 'server.lock'), wait: 'none' })
    await lock.release()
    const queued = await runFixtureCli({ dataDir, tokens, args: ['approvals', 'list'] })
    expect(queued.output).toMatchObject({ approvals: [{ id: prompt.id, summary: 'pending at shutdown', status: 'pending' }] })
  })
})

describe('restart and failed listen (routing-bootstrap-6, routing-bootstrap-2)', () => {
  it('a restart on the same data directory reacquires the lock, initialises once and keeps the data', async () => {
    const dataDir = createDataDir()
    const first = await ready(await serve({ dataDir }))
    const created = await fetch(first.url('/v1/notes'), { method: 'POST', headers: bearer(tokens.agent, { 'content-type': 'application/json' }), body: JSON.stringify({ text: 'before restart' }) })
    expect(created.status).toBe(201)
    expect(await first.stop('SIGTERM')).toBe(0)
    const second = await ready(await serve({ dataDir }))
    expect(await (await fetch(second.url('/v1/notes'), { headers: bearer(tokens.agent) })).json()).toEqual({ notes: [{ id: 1, text: 'before restart', actor: 'agent' }] })
    for (const run of [first, second]) {
      expect(run.events.filter(event => event.message === 'common initialized')).toHaveLength(1)
      expect(run.events.filter(event => event.message === 'ownership lock held')).toHaveLength(1)
    }
  })

  it('closes what it opened and exits 1 when listen fails', async () => {
    const blocker = createServer().listen(0, '127.0.0.1')
    await once(blocker, 'listening')
    try {
      const port = (blocker.address() as AddressInfo).port
      const fixture = startFixture({ args: ['serve'], env: fixtureEnv({ dataDir: createDataDir(), tokens, entry: build.full.entry, extra: { FIXTURE_PORT: String(port) } }) })
      expect(await fixture.exited).toBe(1)
      expect(fixture.events.some(event => event.message === 'listening')).toBe(false)
      expect(fixture.events.find(event => event.message === 'serve failed')?.error).toMatchObject({ code: 'EADDRINUSE' })
      expect(fixture.events.filter(event => event.message === 'close step').map(event => event.fields?.name)).toEqual(expect.arrayContaining(['heartbeat', 'http server', 'cli requester', 'service registry']))
    } finally {
      blocker.close()
    }
  })
})

describe('F39 persistence contract on a startup-resolved path', () => {
  it('HTTP route and CLI share one persistence contract on a startup-resolved path; useDatabase bakes connector options at build time', async () => {
    const dataDir = createDataDir()
    const fixture = await ready(await serve({ dataDir }))
    const created = await fetch(fixture.url('/v1/notes'), { method: 'POST', headers: bearer(tokens.agent, { 'content-type': 'application/json' }), body: JSON.stringify({ text: 'from http' }) })
    expect(created.status).toBe(201)

    const listed = await runFixtureCli({ dataDir, tokens, args: ['notes', 'list'] })
    expect(listed.output).toEqual({ notes: [{ id: 1, text: 'from http', actor: 'agent' }] })
    const added = await runFixtureCli({ dataDir, tokens, args: ['notes', 'add', 'from cli'] })
    expect(added.output).toEqual({ note: { id: 2, text: 'from cli', actor: 'owner-cli' } })
    const overHttp = await (await fetch(fixture.url('/v1/notes'), { headers: bearer(tokens.agent) })).json()
    expect(overHttp).toEqual({ notes: [{ id: 1, text: 'from http', actor: 'agent' }, { id: 2, text: 'from cli', actor: 'owner-cli' }] })
    for (const cli of [listed, added]) expectCleanDiagnostics(cli.process)

    const baked = await (await fetch(fixture.url('/v1/database/baked'), { headers: bearer(tokens.agent) })).json() as { path: string }
    expect(baked.path).toBe(build.full.bakedDatabase)
    expect(relative(dataDir, baked.path).startsWith('..')).toBe(true)
    const route = readFileSync(join(build.full.outDir, '.output/server/_routes/v1/database/baked.mjs'), 'utf8')
    expect(route).toContain(JSON.stringify(build.full.bakedDatabase))
  })
})

describe('F54 explicit imports and fixture boundaries', () => {
  const IMPORT = /\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]/g
  const FRAMEWORK = /^(nitro|h3|srvx|crossws)(\/|$)|^@5straps\/runtime\/nitro$/

  // Every module reachable through relative imports from a directory's files, and the packages they import.
  function importGraph(directory: string): { files: string[]; packages: { file: string; specifier: string }[] } {
    const pending = readdirSync(join(fixtureRoot, directory), { recursive: true, encoding: 'utf8' }).filter(path => path.endsWith('.ts')).map(path => join(fixtureRoot, directory, path))
    const seen = new Set<string>()
    const packages: { file: string; specifier: string }[] = []
    for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
      if (seen.has(file)) continue
      seen.add(file)
      for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
        const specifier = match[1] ?? match[2] ?? match[3]!
        if (specifier.startsWith('.')) pending.push(join(dirname(file), specifier).replace(/\.js$/, '.ts'))
        else packages.push({ file: relative(fixtureRoot, file), specifier })
      }
    }
    return { files: [...seen].map(file => relative(fixtureRoot, file)).sort(), packages }
  }

  it('fixture/common reaches no Nitro, H3, MCP, CLI or server code', () => {
    const graph = importGraph('common')
    expect(graph.packages.filter(({ specifier }) => FRAMEWORK.test(specifier) || specifier.startsWith('@modelcontextprotocol/'))).toEqual([])
    expect(graph.files.filter(file => !file.startsWith('common/'))).toEqual([])
  })

  it('fixture/mcp reaches no Nitro, H3, CLI or server code', () => {
    const graph = importGraph('mcp')
    expect(graph.packages.filter(({ specifier }) => FRAMEWORK.test(specifier))).toEqual([])
    expect(graph.files.filter(file => !/^(mcp|common)\//.test(file))).toEqual([])
  })

  it('fixture/cli reaches no Nitro, H3, MCP or server code', () => {
    const graph = importGraph('cli')
    expect(graph.packages.filter(({ specifier }) => FRAMEWORK.test(specifier) || specifier.startsWith('@modelcontextprotocol/'))).toEqual([])
    expect(graph.files.filter(file => !/^(cli|common)\//.test(file))).toEqual([])
  })
})
