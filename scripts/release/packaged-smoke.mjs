import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
// Strings only Buckle's common code or @5straps/runtime holds: in .output they would mean a bundled second copy.
const BUNDLED_ELSEWHERE = ['This process already has its requester bound', 'Approval was declined', 'A cli:call listener is already registered', 'No operation scope is active']

let service
let serviceOutput = ''
// The whole log of the current start, for counting lines the truncated tail may have lost.
let serviceLog = ''
let entry
let port
let sequence = 0

try {
  prepareInstallation()
  port = await freePort()
  await startService()
  await checkApprovalAndAudit()
  await checkCodeRunOverHttp()
  await checkBackupAndRestore()
  await checkCleanStop()
  await checkSetupWithoutAdminToken()
  await checkSetupWithFlagOff()
  await checkMcpStdio()
  process.stdout.write('Packaged Buckle passed: install, built server, CLI, HTTP authorization, unsigned approval refusal, pinned independent signed approval/retry, audit, a code_run script over HTTP and MCP, backup/restart, conflict-checked restore, SIGTERM clean close, no /setup without an admin token, no /setup with the experimental admin flag off, and MCP over stdio.\n')
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
  assertExecutableBin(join(repository, 'buckle', 'dist', 'main.js'))
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
  assertBuiltServer(join(installation, 'node_modules/@5straps/buckle/.output'))
  // One @5straps/runtime in the installation, shared by main and the built app.
  assert.deepEqual(findPackages(join(installation, 'node_modules'), '@5straps/runtime'), [join(installation, 'node_modules/@5straps/runtime')], 'Expected one @5straps/runtime')
  assert.match(run(join(installation, 'node_modules', '.bin', 'buckle'), ['--version'], { cwd: workspace, env: nodeEnvironment() }), /^\d+\.\d+\.\d+/)
  writeFileSync(join(workspace, 'demo.txt'), 'before')
  assert.match(cli(['tools']), /fs write/)
}

/** The Nitro build ships in the package (files: .output), without native addons or a second runtime copy. */
function assertBuiltServer(output) {
  assert(existsSync(join(output, 'server', 'index.mjs')), 'The installed package has no .output/server/index.mjs')
  const built = walk(output)
  assert.deepEqual(built.filter(path => path.endsWith('.node')), [], 'Native addons found in .output')
  for (const path of built.filter(file => file.endsWith('.mjs'))) {
    const text = readFileSync(path, 'utf8')
    assert.deepEqual(BUNDLED_ELSEWHERE.filter(marker => text.includes(marker)), [], `${path} bundles common or runtime code`)
  }
  assert.match(readFileSync(join(output, 'server', '_routes', 'health', 'ready.mjs'), 'utf8'), /from "@5straps\/runtime\/nitro"/, 'Route chunks must import @5straps/runtime bare')
  // What the bundle took from node_modules ships with it, for scripts/release/audit-bundled.mjs and anyone auditing the package.
  const bundled = JSON.parse(readFileSync(join(output, 'bundled-packages.json'), 'utf8'))
  assert(bundled.some(item => item.startsWith('nitro@')), 'bundled-packages.json does not list nitro')
  assert.deepEqual(bundled.filter(item => /^(?:@5straps\/|@modelcontextprotocol\/|zod@|h3@|@earendil-works\/pi-codemode@|quickjs-wasi@)/.test(item)), [], 'An external package was bundled')
}

function walk(directory) {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' }).map(path => join(directory, path)).filter(path => statSync(path).isFile())
}

/** Every installed copy of a package under node_modules, nested ones included. */
function findPackages(modules, name) {
  return walk(modules).filter(path => path.endsWith(`/node_modules/${name}/package.json`)).map(path => dirname(path))
}

function assertExecutableBin(path) {
  assert.equal(statSync(path).mode & 0o111, 0o111, `${path} is not executable`)
  assert.equal(readFileSync(path, 'utf8').split('\n', 1)[0], '#!/usr/bin/env node', `${path} lacks the node shebang`)
}

/** The admin HTTP layer is experimental (owner decision D8): switched on here wherever the smoke drives /setup. */
function nodeEnvironment({ admin = true, adminHttp = admin } = {}) {
  return { ...environment, BUCKLE_ENV_FILE: join(root, 'no-environment-file'), BUCKLE_HOST: '127.0.0.1',
    BUCKLE_PORT: String(port ?? 4320), BUCKLE_SERVER_ID: 'package-smoke', BUCKLE_WORKSPACE_ROOT: workspace,
    BUCKLE_STATE_DIR: state, BUCKLE_PACKS: 'fs,code', BUCKLE_ALLOW_SHELL: 'false',
    BUCKLE_AUTH_TOKEN: agentToken, ...(admin ? { BUCKLE_ADMIN_TOKEN: adminToken } : {}), ...(adminHttp ? { BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true' } : {}), BUCKLE_APPROVAL_TIMEOUT_MS: '1' }
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

async function startService(options = {}) {
  serviceOutput = ''
  serviceLog = ''
  service = spawn(process.execPath, [entry, 'serve'], { cwd: workspace, env: nodeEnvironment(options), stdio: ['ignore', 'pipe', 'pipe'] })
  let startupError
  service.on('error', error => { startupError = error })
  for (const stream of [service.stdout, service.stderr]) stream.on('data', chunk => { serviceLog += chunk; serviceOutput = (serviceOutput + chunk).slice(-4000) })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (startupError) throw startupError
    if (service.exitCode !== null) throw new Error(`Buckle exited during startup: ${serviceOutput}`)
    try {
      // Liveness answers during startup; readiness waits for the common runtime.
      const response = await fetch(`http://127.0.0.1:${port}/health/ready`, { signal: AbortSignal.timeout(500) })
      if (response.ok) return assertOneCliListener()
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error
      // Otherwise the process has not bound its socket yet.
    }
    await delay(50)
  }
  throw new Error(`Buckle startup timed out: ${serviceOutput}`)
}

function assertOneCliListener() {
  const registered = serviceLog.split('\n').filter(line => line.includes('"cli:call listener registered"'))
  assert.equal(registered.length, 1, `Expected exactly one cli:call listener, saw ${registered.length}`)
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
  const client = await prepareApprovalClient()
  for (const approval of blocked.approvals) {
    await request('/setup/approvals', { body: { token: approval.token, approved: true, scope: 'once' }, status: 409 })
    assert.equal(readFileSync(join(workspace, 'demo.txt'), 'utf8'), 'before')
    await approveVerifiedAction({ client, approval, invocation })
  }
  const completed = await request('/v1/invoke', { token: agentToken, body: { ...invocation,
    requestId: `smoke-${++sequence}`, approvalTokens: blocked.approvals.map(approval => approval.token) } })
  assert.equal(completed.outcome, 'ok')
  assert.equal(readFileSync(join(workspace, 'demo.txt'), 'utf8'), 'after')
  const audit = await request('/setup/audit')
  assert(audit.entries.some(entry => entry.tool === 'fs_write' && entry.outcome === 'ok'))
  assert.match(cli(['log', '--json']), /fs_write/)
}

/** A script that reads a file through fs_read, so code mode's worker and QuickJS binary load from the installed tarball (owner decision D82). */
const CODE_SCRIPT = 'const read = await tools.fs_read({ path: "demo.txt" }); text("read " + read.size); return read.content'

/** One code_run's output as the node returned it: the script ran, called fs_read once, and returned the file. */
function assertCodeRun(output, expected) {
  assert.equal(output.ok, true, `code_run failed: ${JSON.stringify(output.error)}`)
  assert.equal(output.value, expected)
  assert.equal(output.output, `read ${Buffer.byteLength(expected)}`)
  assert.deepEqual(output.calls.map(call => [call.tool, call.status]), [['fs_read', 'ok']])
}

/** `buckle serve`: a code_run over /v1/invoke, whose nested call is audited with the outer call's stage. */
async function checkCodeRunOverHttp() {
  const requestId = `smoke-${++sequence}`
  const ran = await request('/v1/invoke', { token: agentToken, body: { requestId, tool: 'code_run', args: { script: CODE_SCRIPT },
    context: { sessionId: 'smoke-session', stageId: 'code-stage' }, approvalTokens: [] } })
  assert.equal(ran.outcome, 'ok', `code_run over HTTP answered ${JSON.stringify(ran)}`)
  assertCodeRun(ran.output, readFileSync(join(workspace, 'demo.txt'), 'utf8'))
  const audit = await request('/setup/audit')
  assert(audit.entries.some(entry => entry.tool === 'fs_read' && entry.stageId === 'code-stage' && entry.requestId.startsWith('code:')), 'The script\'s fs_read is not in the audit log under its stage')
}

async function prepareApprovalClient() {
  const publicKey = /Public key: +(ed25519:\S+)/.exec(cli(['client', 'keygen']))?.[1]
  assert(publicKey, 'The packaged device client did not generate a public key')
  cli(['keys', 'enroll', publicKey, '--purpose', 'approval', '--workspace', 'default'])
  const nodePublicKey = /Public key: +(ed25519:\S+)/.exec(cli(['keys', 'node']))?.[1]
  assert(nodePublicKey, 'The local node CLI did not expose its public identity')
  const url = `http://127.0.0.1:${port}`
  cli(['client', 'trust', url, 'package-smoke', nodePublicKey])
  const installed = createRequire(join(installation, 'package.json'))
  const protocol = await import(pathToFileURL(installed.resolve('@5straps/protocol/signed-request')).href)
  return { url, nodePublicKey, protocol }
}

async function approveVerifiedAction({ client, approval, invocation }) {
  const { url, nodePublicKey, protocol } = client
  const listing = JSON.parse(cli(['client', 'request', 'GET', `${url}/setup/approvals/challenges`]))
  const item = listing.challenges.find(candidate => candidate.token === approval.token)
  assert(item?.signed, 'The packaged node did not sign the requested challenge')
  const verified = protocol.readChallenge({ signed: item.signed, nodeKey: protocol.publicKeyFrom(nodePublicKey) })
  assert(verified, 'The challenge failed verification against the locally pinned node')
  assert.equal(verified.digest, item.digest)
  assert.equal(verified.challenge.token, approval.token)
  assert.equal(verified.challenge.node, 'package-smoke')
  assert.equal(verified.challenge.workspace, 'default')
  assert.equal(verified.challenge.sessionId, invocation.context.sessionId)
  assert.equal(verified.challenge.tool, invocation.tool)
  assert.deepEqual(verified.challenge.arguments, invocation.args)
  assert.equal(verified.challenge.cwd, workspace)
  assert.equal(verified.challenge.callDigest, protocol.callDigestOf({ tool: invocation.tool, arguments: invocation.args }))
  assert(verified.challenge.description?.includes('demo.txt'))
  assert.deepEqual(verified.challenge.effects, [`write ${join(workspace, 'demo.txt')}`])
  const displayed = cli(['client', 'approvals', url])
  assert(displayed.includes(approval.token) && displayed.includes('demo.txt') && displayed.includes('after') && displayed.includes(workspace), 'The packaged client did not show the complete verified action')
  assert.throws(() => cli(['client', 'approve', url, approval.token]), error => error.status === 1 && String(error.stderr).includes('person at a terminal'), 'A piped packaged client must never approve without confirmation')
  assert(JSON.parse(cli(['approvals', '--json'])).some(candidate => candidate.token === approval.token), 'Non-terminal refusal removed the pending ask')
  const body = JSON.stringify({ token: approval.token, approved: true, scope: 'once', challenge: verified.digest })
  const decided = JSON.parse(cli(['client', 'request', 'POST', `${url}/setup/approvals`, '--body', body]))
  assert.equal(decided.resolved, true)
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

/** SIGTERM closes stage by stage and exits 0, with no close step reporting an error (B19). */
async function checkCleanStop() {
  const child = service
  service = undefined
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  child.kill('SIGTERM')
  const result = await Promise.race([closed, delay(30_000).then(() => null)])
  if (!result) {
    child.kill('SIGKILL')
    throw new Error(`Buckle did not exit within 30 s of SIGTERM: ${serviceOutput}`)
  }
  assert.deepEqual(result, { code: 0, signal: null }, `Buckle did not exit 0 on SIGTERM: ${serviceOutput}`)
  assert(serviceLog.includes('"5straps Buckle stopped"'), 'Buckle stopped without its last close line')
  assert(!serviceLog.includes('"Buckle closed with errors"'), `A close step failed: ${serviceOutput}`)
}

/**
 * A node started without BUCKLE_ADMIN_TOKEN has no owner's face: /setup answers 404 to every caller,
 * with the experimental admin flag on, so the token check is what answers (review M4 of B23-B25).
 */
async function checkSetupWithoutAdminToken() {
  await startService({ admin: false, adminHttp: true })
  for (const token of [adminToken, agentToken, undefined]) {
    const response = await fetch(`http://127.0.0.1:${port}/setup/status`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(10_000) })
    await response.body?.cancel()
    assert.equal(response.status, 404, 'A node without an admin token must serve no /setup')
  }
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/manifest`, { headers: { authorization: `Bearer ${agentToken}` }, signal: AbortSignal.timeout(10_000) })).status, 200)
  await checkCleanStop()
}

/**
 * Owner decision D8: with an admin token set but BUCKLE_EXPERIMENTAL_ADMIN_HTTP unset, as a user's
 * install starts, /setup answers 404 to every caller, the admin credential included, as an unmatched
 * path does.
 */
async function checkSetupWithFlagOff() {
  await startService({ admin: true, adminHttp: false })
  const unmatched = await fetch(`http://127.0.0.1:${port}/not-a-route`, { signal: AbortSignal.timeout(10_000) })
  const expected = await unmatched.text()
  for (const [path, token] of [['/setup/status', adminToken], ['/setup/policy', adminToken], ['/workspaces/default/setup/status', adminToken], ['/setup/status', agentToken], ['/setup/status', undefined]]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(10_000) })
    assert.equal(response.status, 404, `${path} must answer 404 while the experimental admin flag is off`)
    assert.equal(await response.text(), expected, `${path} must answer as an unmatched path does`)
  }
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/manifest`, { headers: { authorization: `Bearer ${agentToken}` }, signal: AbortSignal.timeout(10_000) })).status, 200)
  await checkCleanStop()
}

/**
 * `buckle mcp` over stdio: initialize and tools/list answer on stdout, which carries protocol lines
 * only, and closing stdin ends it with exit 0. Whatever fails on the way, the child is killed, so a
 * failing smoke never hangs (review L6 of B20-B22).
 */
async function checkMcpStdio() {
  const child = spawn(process.execPath, [entry, 'mcp'], { cwd: workspace, env: nodeEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000) })
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  try {
    const protocolVersion = '2026-07-28'
    const meta = { 'io.modelcontextprotocol/protocolVersion': protocolVersion, 'io.modelcontextprotocol/clientCapabilities': {} }
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 'package-smoke', version: '0' } } })}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: meta } })}\n`)
    // Complete lines only: the last piece may still be arriving.
    const lines = () => stdout.split('\n').slice(0, -1).filter(Boolean).map(protocolLine)
    const deadline = Date.now() + 20_000
    while (lines().filter(message => message.id === 1 || message.id === 2).length < 2) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`buckle mcp did not answer initialize and tools/list: ${stderr}`)
      await delay(50)
    }
    const [initialized, listed] = [1, 2].map(id => lines().find(message => message.id === id))
    assert(initialized.result?.serverInfo?.name, `initialize answered without server info: ${JSON.stringify(initialized)}`)
    assert(listed.result?.tools?.some(tool => tool.name === 'fs_write'), 'tools/list does not list fs_write')
    // `buckle mcp`: the same script through MCP's tools/call.
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'code_run', arguments: { script: CODE_SCRIPT }, _meta: meta } })}\n`)
    while (!lines().some(message => message.id === 3)) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`buckle mcp did not answer code_run: ${stderr}`)
      await delay(50)
    }
    const called = lines().find(message => message.id === 3)
    assert.notEqual(called.result?.isError, true, `code_run over MCP failed: ${JSON.stringify(called)}`)
    assertCodeRun(JSON.parse(called.result.content[0].text), readFileSync(join(workspace, 'demo.txt'), 'utf8'))
    assert(lines().every(message => message.jsonrpc === '2.0'), 'stdout carried something other than MCP messages')
    child.stdin.end()
    const result = await Promise.race([closed, delay(30_000).then(() => null)])
    if (!result) throw new Error('buckle mcp did not exit within 30 s of its client closing stdin')
    assert.deepEqual(result, { code: 0, signal: null }, `buckle mcp did not exit 0: ${stderr}`)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await closed
    }
  }
}

/** One stdout line of `buckle mcp`, which must be a JSON-RPC message; anything else fails the smoke with the line. */
function protocolLine(line) {
  try {
    return JSON.parse(line)
  } catch {
    throw new Error(`buckle mcp wrote a line on stdout that is not JSON: ${line.slice(0, 200)}`)
  }
}
