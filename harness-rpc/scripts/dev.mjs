// The dev loop (ruling 10 of 2026-09-28: dev may restart). Builds the package, starts `buckle serve`
// from the build with the terminal attached, and after each change rebuilds and restarts it. A failed
// build keeps the running node and prints the errors. `nitro dev` is not used: it runs the app in a
// worker outside main's bootstrap, so the host, the cli:call listener and close would not be the ones
// serve runs.
import { spawn } from 'node:child_process'
import { cpSync, existsSync, renameSync, rmSync, watch } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const PACKAGE_ROOT = resolve(import.meta.dirname, '..')
const WATCHED = ['main.ts', 'nitro.config.ts', 'common', 'cli', 'mcp', 'layers', 'server', 'skills']
const DEBOUNCE_MS = 300
// Past this, a node that has not finished closing is killed: longer than a clean close, which settles
// open approval waits and drains connections.
const CLOSE_BOUND_MS = 15_000
// The Nitro build lands here first, so the running node never lazily loads a half-written .output.
const STAGED_OUTPUT = join(PACKAGE_ROOT, 'node_modules', '.cache', 'buckle-dev', 'output')
const OUTPUT = join(PACKAGE_ROOT, '.output')

let child = null
let building = false
let pending = false
let stopping = false
let timer

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop(0) })
say(`building; watching ${WATCHED.join(', ')}`)
if (await build()) start()
else say('the first build failed; fix it and save to try again')
for (const path of WATCHED) watch(join(PACKAGE_ROOT, path), { recursive: true }, onChange)

function onChange(_event, name) {
  if (stopping || name?.includes('node_modules')) return
  clearTimeout(timer)
  timer = setTimeout(() => { void rebuild() }, DEBOUNCE_MS)
}

/** One build at a time; a change saved during a build starts another once it ends. */
async function rebuild() {
  if (building) {
    pending = true
    return
  }
  const started = performance.now()
  say('change seen; rebuilding')
  if (!await build()) {
    say(child ? 'build failed; the running node stays up' : 'build failed')
    return drainPending()
  }
  await stopChild()
  start()
  say(`rebuilt and restarted in ${Math.round(performance.now() - started)} ms (until the new node starts; it answers /health/ready once ready)`)
  return drainPending()
}

function drainPending() {
  if (!pending || stopping) return
  pending = false
  return rebuild()
}

async function build() {
  building = true
  try {
    rmSync(STAGED_OUTPUT, { recursive: true, force: true })
    return await run(['scripts/build.mjs', '--incremental']) && await run(['scripts/build-server.mjs', '--out-dir', STAGED_OUTPUT])
  } finally {
    building = false
  }
}

function run(args) {
  return new Promise(resolveRun => {
    const step = spawn(process.execPath, args, { cwd: PACKAGE_ROOT, stdio: ['ignore', 'inherit', 'inherit'] })
    step.once('error', () => resolveRun(false))
    step.once('exit', code => resolveRun(code === 0))
  })
}

// The same bootstrap as an installed node: dist/main.js finds .output from the package root.
function start() {
  if (existsSync(STAGED_OUTPUT)) replaceOutput()
  child = spawn(process.execPath, ['--env-file-if-exists=../.env', 'dist/main.js', 'serve'], { cwd: PACKAGE_ROOT, stdio: 'inherit' })
  const current = child
  say(`started buckle serve (pid ${current.pid})`)
  current.once('exit', (code, signal) => {
    if (child !== current) return
    child = null
    // A node the owner stopped (Ctrl-C at a question) ends the loop; a failed one waits for a fix.
    if (code === 0 && !stopping) return void stop(0)
    if (!stopping) say(`buckle serve exited (${signal ?? `code ${code}`}); save a change to restart it`)
  })
}

// A node_modules linked from another file system cannot rename across; copying is the same result.
function replaceOutput() {
  rmSync(OUTPUT, { recursive: true, force: true })
  try {
    renameSync(STAGED_OUTPUT, OUTPUT)
  } catch (error) {
    if (error.code !== 'EXDEV') throw error
    cpSync(STAGED_OUTPUT, OUTPUT, { recursive: true })
    rmSync(STAGED_OUTPUT, { recursive: true, force: true })
  }
}

/** SIGTERM runs the node's close stages; SIGKILL only once they overrun the bound. */
async function stopChild() {
  const current = child
  child = null
  if (!current || current.exitCode !== null || current.signalCode !== null) return
  const exited = new Promise(resolveExit => current.once('exit', resolveExit))
  current.kill('SIGTERM')
  const overran = await Promise.race([exited.then(() => false), delay(CLOSE_BOUND_MS).then(() => true)])
  if (!overran) return
  say(`buckle serve did not close within ${CLOSE_BOUND_MS} ms; killing it`)
  current.kill('SIGKILL')
  await exited
}

async function stop(code) {
  if (stopping) return
  stopping = true
  clearTimeout(timer)
  // Ctrl-C also reached the node, which is closing already; SIGTERM asks for the same idempotent close.
  await stopChild()
  process.exit(code)
}

function say(message) {
  process.stderr.write(`[buckle dev] ${message}\n`)
}
