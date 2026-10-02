// The dev loop (ruling 10 of 2026-09-28: dev may restart). Builds the package, starts `buckle serve`
// from the build with the terminal attached, and after each change rebuilds and restarts it. A failed
// build keeps the running node and prints the errors. `nitro dev` is not used: it runs the app in a
// worker outside main's bootstrap, so the host, the cli:call listener and close would not be the ones
// serve runs.
//
// Accepted for dev: tsc rewrites dist in place while the old node still runs, so a lazy import in that
// node can load new code, and files from deleted sources stay in dist until a full build. The Nitro
// output is staged and swapped only once the old node has exited. The machine's global `buckle` runs
// from this dist and .output too, so a dev cycle changes what it runs.
import { spawn } from 'node:child_process'
import { cpSync, existsSync, renameSync, rmSync, watch } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const PACKAGE_ROOT = resolve(import.meta.dirname, '..')
// Directories are watched recursively. The two root files are found by name in a watch on the package
// root, because an editor's atomic save replaces the file and a watch on the file itself goes quiet.
const WATCHED_DIRECTORIES = ['common', 'cli', 'mcp', 'layers', 'server', 'skills']
const WATCHED_FILES = new Set(['main.ts', 'nitro.config.ts'])
const DEBOUNCE_MS = 300
// Past this, a node that has not finished closing is killed: longer than a clean close, which settles
// open approval waits and drains connections.
const CLOSE_BOUND_MS = 15_000
// The Nitro build lands here first, so the running node never lazily loads a half-written .output.
const STAGED_OUTPUT = join(PACKAGE_ROOT, 'node_modules', '.cache', 'buckle-dev', 'output')
const OUTPUT = join(PACKAGE_ROOT, '.output')
// The settings file the repository root's .env.example documents; serve starts without it when absent.
const ENV_FILE = join(PACKAGE_ROOT, '..', '.env')

let child = null
// One cycle at a time, from the build through stopping the old node to starting the new one, so a
// later build never clears or rewrites the staged output while it is being swapped in (review L5 of B13-B14).
let busy = false
let pending = false
let stopping = false
let timer

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop(0) })
say(`building; watching ${[...WATCHED_FILES, ...WATCHED_DIRECTORIES].join(', ')}`)
await cycle({ first: true })
for (const path of WATCHED_DIRECTORIES) watch(join(PACKAGE_ROOT, path), { recursive: true }, onChange)
watch(PACKAGE_ROOT, (event, name) => { if (WATCHED_FILES.has(name)) onChange(event, name) })

function onChange(_event, name) {
  if (stopping || name?.includes('node_modules')) return
  clearTimeout(timer)
  timer = setTimeout(() => { void cycle({ first: false }) }, DEBOUNCE_MS)
}

/** Build, then stop the old node and start the new one; a change saved meanwhile runs one more cycle after. */
async function cycle({ first }) {
  if (busy) {
    pending = true
    return
  }
  busy = true
  try {
    await buildAndRestart(first)
  } finally {
    busy = false
  }
  if (pending && !stopping) {
    pending = false
    return cycle({ first: false })
  }
}

async function buildAndRestart(first) {
  const started = performance.now()
  if (!first) say('change seen; rebuilding')
  if (!await build()) {
    say(first ? 'the first build failed; fix it and save to try again' : child ? 'build failed; the running node stays up' : 'build failed')
    return
  }
  await stopChild()
  if (stopping) return
  start()
  if (!first) say(`rebuilt and restarted in ${Math.round(performance.now() - started)} ms (until the new node starts; it answers /health/ready once ready)`)
}

async function build() {
  rmSync(STAGED_OUTPUT, { recursive: true, force: true })
  return await run(['scripts/build.mjs', '--incremental']) && await run(['scripts/build-server.mjs', '--out-dir', STAGED_OUTPUT])
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
  child = spawn(process.execPath, [`--env-file-if-exists=${ENV_FILE}`, 'dist/main.js', 'serve'], { cwd: PACKAGE_ROOT, stdio: 'inherit' })
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
