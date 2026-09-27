import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const root = mkdtempSync(join(tmpdir(), '5straps-package-smoke-'))
const packageDirectory = join(root, 'packages')
const installation = join(root, 'installation')
const workspace = join(root, 'workspace')
const state = join(root, 'state')
const backup = join(root, 'backup')
const agentToken = randomBytes(32).toString('hex')
const adminToken = randomBytes(32).toString('hex')
const environment = { PATH: process.env.PATH, HOME: root, TMPDIR: root, SystemRoot: process.env.SystemRoot,
  npm_config_userconfig: join(root, 'npmrc'), npm_config_audit: 'false', npm_config_fund: 'false' }
let service
let serviceOutput = ''
let entry
let port
let sequence = 0

try {
  prepareInstallation()
  port = await freePort()
  await startService()
  await checkApprovalAndAudit()
  await checkBackupAndRestore()
  process.stdout.write('Packaged Buckle passed: install, CLI, HTTP authorization, approval/retry, audit, backup/restart and conflict-checked restore.\n')
} catch (error) {
  process.stderr.write(`Packaged Buckle smoke failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await stopService()
  rmSync(root, { recursive: true, force: true })
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: installation, env: environment, encoding: 'utf8', timeout: 180_000, ...options })
}

function prepareInstallation() {
  for (const directory of [packageDirectory, installation, workspace]) mkdirSync(directory)
  // The state directory holds workspace credentials; Buckle refuses one other users can reach.
  mkdirSync(state, { mode: 0o700 })
  writeFileSync(join(root, 'npmrc'), '')
  for (const name of ['protocol', 'runtime', 'buckle']) {
    run('pnpm', ['--filter', `@5straps/${name}`, 'pack', '--pack-destination', packageDirectory], { cwd: repository })
  }
  // A global `buckle` symlink points straight at the build, so the build itself must leave an executable bin.
  assertExecutableBin(join(repository, 'harness-rpc', 'dist', 'main.js'))
  const tarball = name => {
    const matches = readdirSync(packageDirectory).filter(file => file.startsWith(`5straps-${name}-`) && file.endsWith('.tgz'))
    assert.equal(matches.length, 1, `Expected one ${name} package`)
    return `file:${join(packageDirectory, matches[0])}`
  }
  writeFileSync(join(installation, 'package.json'), JSON.stringify({ private: true, dependencies: {
    '@5straps/protocol': tarball('protocol'), '@5straps/runtime': tarball('runtime'), '@5straps/buckle': tarball('buckle'),
  } }))
  run('npm', ['install', '--ignore-scripts', '--omit=optional'])
  entry = join(installation, 'node_modules/@5straps/buckle/dist/main.js')
  assert(existsSync(entry), 'Installed CLI entry is missing')
  assertExecutableBin(entry)
  assert.match(run(join(installation, 'node_modules', '.bin', 'buckle'), ['--version'], { cwd: workspace, env: nodeEnvironment() }), /^\d+\.\d+\.\d+/)
  writeFileSync(join(workspace, 'demo.txt'), 'before')
  assert.match(cli(['tools']), /fs write/)
}

function assertExecutableBin(path) {
  assert.equal(statSync(path).mode & 0o111, 0o111, `${path} is not executable`)
  assert.equal(readFileSync(path, 'utf8').split('\n', 1)[0], '#!/usr/bin/env node', `${path} lacks the node shebang`)
}

function nodeEnvironment() {
  return { ...environment, BUCKLE_ENV_FILE: join(root, 'no-environment-file'), BUCKLE_HOST: '127.0.0.1',
    BUCKLE_PORT: String(port ?? 4320), BUCKLE_SERVER_ID: 'package-smoke', BUCKLE_WORKSPACE_ROOT: workspace,
    BUCKLE_STATE_DIR: state, BUCKLE_PACKS: 'fs', BUCKLE_ALLOW_SHELL: 'false',
    BUCKLE_AUTH_TOKEN: agentToken, BUCKLE_ADMIN_TOKEN: adminToken, BUCKLE_APPROVAL_TIMEOUT_MS: '0' }
}

function cli(args) {
  return run(process.execPath, [entry, ...args], { cwd: workspace, env: nodeEnvironment() })
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert(address && typeof address !== 'string')
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}

async function startService() {
  serviceOutput = ''
  service = spawn(process.execPath, [entry, 'serve'], { cwd: workspace, env: nodeEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] })
  let startupError
  service.on('error', error => { startupError = error })
  for (const stream of [service.stdout, service.stderr]) stream.on('data', chunk => { serviceOutput = (serviceOutput + chunk).slice(-4000) })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (startupError) throw startupError
    if (service.exitCode !== null) throw new Error(`Buckle exited during startup: ${serviceOutput}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })
      if (response.ok) return
    } catch { /* The process has not bound its socket yet. */ }
    await delay(50)
  }
  throw new Error(`Buckle startup timed out: ${serviceOutput}`)
}

async function stopService() {
  const child = service
  service = undefined
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise(resolve => child.once('exit', resolve))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
  try { await exited } finally { clearTimeout(timer) }
}

async function request(path, { token = adminToken, body, status = 200 } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
  })
  assert.equal(response.status, status, `Unexpected status for ${path}`)
  return response.json()
}

async function checkApprovalAndAudit() {
  await request('/setup/audit', { token: agentToken, status: 401 })
  const invocation = { requestId: `smoke-${++sequence}`, tool: 'fs_write', args: { path: 'demo.txt', content: 'after' },
    context: { sessionId: 'smoke-session', stageId: 'smoke-stage' }, approvalTokens: [] }
  const blocked = await request('/v1/invoke', { token: agentToken, body: invocation })
  assert.equal(blocked.outcome, 'approval_required')
  assert.equal(readFileSync(join(workspace, 'demo.txt'), 'utf8'), 'before')
  const pending = await request('/setup/approvals')
  assert.equal(pending.approvals.length, blocked.approvals.length)
  const commandQueue = JSON.parse(cli(['approvals', '--json']))
  assert(Array.isArray(commandQueue) && commandQueue.length > 0)
  for (const approval of blocked.approvals) {
    await request('/setup/approvals', { body: { token: approval.token, approved: true, scope: 'once' } })
  }
  const completed = await request('/v1/invoke', { token: agentToken, body: { ...invocation,
    requestId: `smoke-${++sequence}`, approvalTokens: blocked.approvals.map(approval => approval.token) } })
  assert.equal(completed.outcome, 'ok')
  assert.equal(readFileSync(join(workspace, 'demo.txt'), 'utf8'), 'after')
  const audit = await request('/setup/audit')
  assert(audit.entries.some(entry => entry.tool === 'fs_write' && entry.outcome === 'ok'))
  assert.match(cli(['log', '--json']), /fs_write/)
}

async function checkBackupAndRestore() {
  const checkpoints = (await request('/setup/history')).checkpoints
  const checkpoint = checkpoints.find(item => item.sessionId === 'smoke-session')
  assert(checkpoint, 'The approved write has no checkpoint')
  await stopService()
  mkdirSync(backup)
  cpSync(workspace, join(backup, 'workspace'), { recursive: true })
  cpSync(state, join(backup, 'state'), { recursive: true })
  rmSync(workspace, { recursive: true })
  rmSync(state, { recursive: true })
  cpSync(join(backup, 'workspace'), workspace, { recursive: true })
  cpSync(join(backup, 'state'), state, { recursive: true })
  // A copy does not keep the directory's mode, and the node refuses a state directory others can reach.
  chmodSync(state, 0o700)
  await startService()
  const audit = await request('/setup/audit')
  assert(audit.entries.some(entry => entry.tool === 'fs_write' && entry.outcome === 'ok'))
  writeFileSync(join(workspace, 'demo.txt'), 'external edit')
  await request(`/setup/history/${encodeURIComponent(checkpoint.id)}/restore`, { body: {}, status: 409 })
  assert.equal(readFileSync(join(workspace, 'demo.txt'), 'utf8'), 'external edit')
  writeFileSync(join(workspace, 'demo.txt'), 'after')
  await request(`/setup/history/${encodeURIComponent(checkpoint.id)}/restore`, { body: {} })
  assert.equal(readFileSync(join(workspace, 'demo.txt'), 'utf8'), 'before')
}
