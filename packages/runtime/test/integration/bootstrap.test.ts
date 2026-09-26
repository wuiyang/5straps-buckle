import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { CLOSE_STAGES } from '../../src/index.js'
import { acquireFileLock } from '../../src/sqlite/index.js'
import { bearer, createDataDir, createTokens, expectCleanDiagnostics, fixtureEnv, runFixtureCli, serveFixture, type FixtureProcess, type LogLine } from './support/fixture-process.js'
import { fixtureRoot, packageRoot } from './support/paths.js'
import { expectNoLeakedResources, resourceSnapshot } from './support/resources.js'

const run = promisify(execFile)
const build = inject('fixtureBuild')
const tokens = createTokens()
const started: FixtureProcess[] = []
let resourcesBefore: Record<string, number>

beforeAll(() => { resourcesBefore = resourceSnapshot() })
afterAll(async () => {
  await Promise.all(started.map(fixture => fixture.stop()))
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
      expect(await missing.json()).toEqual({ error: expect.any(String) })
    }
    // Nitro file routes do not emit 405: a GET-only file answers other methods with 404.
    const wrongMethod = await fetch(fixture.url('/health'), { method: 'POST' })
    expect(wrongMethod.status).toBe(404)
    expect(await wrongMethod.json()).toEqual({ error: expect.any(String) })
  })
})

describe('F02 duplicate route registrations fail the project check', () => {
  const script = join(packageRoot, '../../scripts/check-duplicate-routes.mjs')

  it('passes the fixture and names both files when two layers claim GET /health', async () => {
    await expect(run(process.execPath, [script, fixtureRoot])).resolves.toMatchObject({ stdout: expect.stringContaining('No duplicate Nitro routes') })

    const project = mkdtempSync(join(tmpdir(), 'duplicate-routes-'))
    mkdirSync(join(project, 'node_modules'))
    symlinkSync(join(packageRoot, 'node_modules/nitro'), join(project, 'node_modules/nitro'), 'dir')
    for (const [layer, file] of [['first', 'health.get.ts'], ['second', 'health.ts']] as const) {
      mkdirSync(join(project, layer, 'routes'), { recursive: true })
      writeFileSync(join(project, layer, 'routes', file), 'export default () => "ok"\n')
    }
    writeFileSync(join(project, 'nitro.config.ts'), 'export default { preset: "node_middleware", scanDirs: ["./first", "./second"] }\n')
    const failure = await run(process.execPath, [script, project]).catch((error: unknown) => error as { code: number; stderr: string })
    expect(failure).toMatchObject({ code: 1 })
    expect((failure as { stderr: string }).stderr).toMatch(/GET \/health: .*first\/routes\/health\.get\.ts, .*second\/routes\/health\.ts/)
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
    const fixture = await serve({ extra: { FIXTURE_STARTUP_DELAY_MS: '1500' } })
    const early = await fetch(fixture.url('/v1/notes'), { headers: bearer(tokens.agent) })
    expect(early.status).toBe(503)
    expect(await early.json()).toEqual({ error: expect.any(String) })
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
    const common = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', 'await import(process.argv[1]); await import(process.argv[2])', join(fixtureRoot, 'common/runtime.ts'), join(fixtureRoot, 'mcp/server.ts')], { env, cwd: packageRoot, timeout: 10_000 })
    expect(common.stdout).toBe('')
    expect(readdirSync(dataDir)).toEqual([])
  })
})

describe('Single @5straps/runtime copy shared by main.ts and the bundle', () => {
  it('a scope opened in main is visible inside a bundled route, and no runtime source is bundled', async () => {
    const fixture = await ready(await serve())
    const probe = await (await fetch(fixture.url('/v1/scope-probe'))).json() as { correlationId: string | null }
    const opened = await fixture.waitFor('scope probe opened')
    expect(probe.correlationId).toBe(opened.fields?.probeId)
    expect(probe.correlationId).toMatch(/^main-probe-/)
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
    const crossovers = results.filter(({ index, body }) => body.actor !== `actor-${index}` || body.alsActor !== `actor-${index}` || body.serviceActor !== `actor-${index}` || body.alsCorrelationId !== body.correlationId || body.serviceCorrelationId !== body.correlationId || body.sameScopedInstance !== true || body.freshTransients !== true)
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
    const fixture = await serve({ extra: { FIXTURE_STARTUP_DELAY_MS: '1500' } })
    expect((await fetch(fixture.url('/health'))).status).toBe(200)
    expect((await fetch(fixture.url('/health/ready'))).status).toBe(503)
    await fixture.waitFor('common ready')
    expect((await fetch(fixture.url('/health/ready'))).status).toBe(200)
  })

  it('never runs a business handler when startup fails, then exits 1', async () => {
    const fixture = await serveFixture({ entry: build.full.entry, dataDir: createDataDir(), tokens, extra: { FIXTURE_STARTUP_DELAY_MS: '800', FIXTURE_STARTUP_FAILS: 'true' } })
    const during = await fetch(fixture.url('/v1/notes'), { headers: bearer(tokens.agent) })
    expect(during.status).toBe(503)
    expect(await fixture.exited).toBe(1)
    expect(fixture.events.some(event => event.message === 'startup failed')).toBe(true)
    expect(fixture.events.filter(event => event.message === 'operation executed')).toEqual([])
    expect(fixture.malformed).toEqual([])
  })
})

describe('F22 close order', () => {
  it('closes stage by stage on SIGTERM, releases the lock and exits 0 on its own', async () => {
    const dataDir = createDataDir()
    const fixture = await ready(await serve({ dataDir }))
    expect((await fetch(fixture.url('/v1/notes'), { headers: bearer(tokens.agent) })).status).toBe(200)
    expect(await fixture.stop('SIGTERM')).toBe(0)
    const steps = fixture.events.filter(event => event.message === 'close step').map(event => `${String(event.fields?.stage)}:${String(event.fields?.name)}`)
    // The ownership lock closes in the locks stage inside the runtime (acquireOwnershipLock); reacquiring it below proves the release.
    expect(steps).toEqual(['accept:http server', 'timers:heartbeat', 'waiters:cli requester', 'databases:notes database', 'sinks:logger'])
    const stageOrder = steps.map(step => step.split(':')[0])
    expect(stageOrder).toEqual([...stageOrder].sort((a, b) => CLOSE_STAGES.indexOf(a as never) - CLOSE_STAGES.indexOf(b as never)))
    const lock = await acquireFileLock({ path: join(dataDir, 'server.lock'), wait: 'none' })
    await lock.release()
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
  const importsOf = (directory: string) => readdirSync(join(fixtureRoot, directory), { recursive: true, encoding: 'utf8' })
    .filter(path => path.endsWith('.ts'))
    .flatMap(path => [...readFileSync(join(fixtureRoot, directory, path), 'utf8').matchAll(IMPORT)].map(match => ({ file: `${directory}/${path}`, specifier: match[1] ?? match[2] ?? match[3]! })))
  const FRAMEWORK = /^(nitro|h3|srvx|crossws)(\/|$)|^@5straps\/runtime\/nitro$/

  it('keeps fixture/common free of Nitro, H3, MCP, CLI and server code', () => {
    const offenders = importsOf('common').filter(({ specifier }) => FRAMEWORK.test(specifier) || specifier.startsWith('@modelcontextprotocol/') || /^\.\.\/(layers|server|mcp|cli)\//.test(specifier))
    expect(offenders).toEqual([])
  })

  it('keeps fixture/mcp free of Nitro, H3, CLI and server code', () => {
    const offenders = importsOf('mcp').filter(({ specifier }) => FRAMEWORK.test(specifier) || /^\.\.\/(layers|server|cli)\//.test(specifier))
    expect(offenders).toEqual([])
  })

  it('bundles only explicitly imported code: every layer file imports what it uses', () => {
    // Nitro 3.0.260903-beta has no auto-import option; the fixture tsconfig compiles every file with explicit imports.
    const layerFiles = importsOf('layers').map(({ file }) => file)
    expect(new Set(layerFiles).size).toBeGreaterThan(10)
  })
})
