// Packaged @5straps/runtime smoke (F56): pack the runtime and a tiny prebuilt Nitro fixture, install
// both the way a user would, then run the built server, open a database and hold a lock.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const runtimePackage = join(repository, 'packages/runtime')
const fixtureSource = join(runtimePackage, 'test/package-smoke')
const FIXTURE_NAME = '@5straps/runtime-smoke-fixture'
const root = mkdtempSync(join(tmpdir(), '5straps-runtime-smoke-'))
const packages = join(root, 'packages')
const staging = join(root, 'fixture')
const installation = join(root, 'installation')
const dataDir = join(root, 'data')
const environment = { PATH: process.env.PATH, HOME: root, TMPDIR: root, SystemRoot: process.env.SystemRoot,
  npm_config_userconfig: join(root, 'npmrc'), npm_config_audit: 'false', npm_config_fund: 'false' }
let server

try {
  const runtime = JSON.parse(readFileSync(join(runtimePackage, 'package.json'), 'utf8'))
  for (const directory of [packages, staging, installation, dataDir]) mkdirSync(directory)
  writeFileSync(join(root, 'npmrc'), '')
  await buildFixture()
  assertNoNativeAddons(join(staging, '.output'), 'the built .output')
  packAll(runtime)
  install()
  const entry = join(installation, 'node_modules', FIXTURE_NAME, 'main.mjs')
  assert(existsSync(entry), 'Installed fixture entry is missing')
  assertNoNativeAddons(join(installation, 'node_modules'), 'the installation')
  const port = await startServer(entry)
  await checkServer(port)
  checkLockHeld()
  await stopServer()
  checkLockReleased()
  process.stdout.write(`Packaged runtime passed on ${process.platform}-${process.arch}: install, built Nitro server, database, ownership lock, no native addons.\n`)
} catch (error) {
  process.stderr.write(`Packaged runtime smoke failed: ${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
} finally {
  await stopServer()
  rmSync(root, { recursive: true, force: true })
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: installation, env: environment, encoding: 'utf8', timeout: 180_000, ...options })
}

// Built from the repository, where nitro is a devDependency; the tarball ships only the output.
async function buildFixture() {
  const builder = createRequire(join(runtimePackage, 'package.json')).resolve('nitro/builder')
  const { build, copyPublicAssets, createNitro, prepare } = await import(pathToFileURL(builder).href)
  const nitro = await createNitro({ rootDir: fixtureSource, dev: false, logLevel: 1, buildDir: join(root, '.nitro'), output: { dir: join(staging, '.output') } })
  await prepare(nitro)
  await copyPublicAssets(nitro)
  await build(nitro)
  await nitro.close()
  cpSync(join(fixtureSource, 'main.mjs'), join(staging, 'main.mjs'))
}

function packAll(runtime) {
  run('pnpm', ['--filter', '@5straps/runtime', 'pack', '--pack-destination', packages], { cwd: repository })
  const h3 = runtime.peerDependencies.h3
  // The runtime's nitro entry imports h3 at run time, so a backend that keeps the runtime external installs it.
  writeFileSync(join(staging, 'package.json'), JSON.stringify({ name: FIXTURE_NAME, version: '0.0.0', private: true, type: 'module',
    files: ['.output', 'main.mjs'], peerDependencies: { '@5straps/runtime': runtime.version }, dependencies: { h3 } }, null, 2))
  run('npm', ['pack', '--pack-destination', packages], { cwd: staging })
}

function install() {
  const tarball = prefix => {
    const matches = readdirSync(packages).filter(file => file.startsWith(prefix) && file.endsWith('.tgz'))
    assert.equal(matches.length, 1, `Expected one ${prefix} package`)
    return `file:${join(packages, matches[0])}`
  }
  writeFileSync(join(installation, 'package.json'), JSON.stringify({ private: true, dependencies: {
    '@5straps/runtime': tarball('5straps-runtime-0'), [FIXTURE_NAME]: tarball('5straps-runtime-smoke-fixture-'),
  } }))
  run('npm', ['install', '--ignore-scripts', '--omit=optional'])
}

function assertNoNativeAddons(directory, label) {
  const addons = walk(directory).filter(path => path.endsWith('.node'))
  assert.deepEqual(addons, [], `Native addons found in ${label}`)
}

function walk(directory) {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' }).map(path => join(directory, path)).filter(path => statSync(path).isFile())
}

function startServer(entry) {
  server = spawn(process.execPath, [entry], { cwd: installation, env: { ...environment, SMOKE_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] })
  let diagnostics = ''
  server.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4000) })
  return new Promise((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${diagnostics}`)), 20_000)
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code} during startup: ${diagnostics}`)) })
    createInterface({ input: server.stdout }).once('line', (line) => {
      clearTimeout(timer)
      resolvePort(JSON.parse(line).port)
    })
  })
}

async function checkServer(port) {
  const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5_000) })
  assert.equal(health.status, 200)
  // Readiness follows the main-owned start, which opens the database and takes the lock.
  const deadline = Date.now() + 10_000
  let ready
  do {
    ready = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(5_000) })
    if (ready.status === 200) break
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50))
  } while (Date.now() < deadline)
  assert.equal(ready.status, 200, 'The built route never saw the runtime become ready')
  assert.deepEqual(await ready.json(), { status: 'ready', scoped: true })
}

// A second process must see the server's ownership lock as busy while it runs, and free after exit.
function tryLock() {
  const script = "import('@5straps/runtime/sqlite').then(async ({ acquireFileLock }) => { try { const lock = await acquireFileLock({ path: process.argv[1], wait: 'none' }); await lock.release(); console.log('acquired') } catch (error) { console.log(error.code) } })"
  return run(process.execPath, ['--input-type=module', '-e', script, join(dataDir, 'smoke.lock')]).trim()
}

function checkLockHeld() {
  assert.equal(tryLock(), 'LockBusyError')
}

function checkLockReleased() {
  assert.equal(tryLock(), 'acquired')
}

async function stopServer() {
  const child = server
  server = undefined
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise(resolveExit => child.once('exit', resolveExit))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
  try {
    assert.equal(await exited, 0, 'Server did not exit cleanly on SIGTERM')
  } finally {
    clearTimeout(timer)
  }
}
