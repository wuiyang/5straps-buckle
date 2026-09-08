import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeferredApprovalChannel } from '../dist/adapters/approval/deferred-approval-channel.js'
import { runProcess } from '../dist/adapters/process-runner.js'
import { resolveSandbox } from '../dist/adapters/sandbox/create-sandbox.js'
import { loadConfig } from '../dist/config.js'
import { createPathView } from '../dist/domain/path-view.js'
import { logger } from '../dist/logger.js'
import { createShellPack } from '../dist/packs/shell/index.js'
import { createRuntime } from '../dist/runtime.js'
import { createChangeHistory } from '../dist/services/history/journal.js'

const checks = { browser: checkBrowser, sandbox: checkSandbox }
const selected = process.argv[2] ?? 'all'
assert(selected === 'all' || Object.hasOwn(checks, selected), 'Use all, browser, or sandbox')
for (const [name, check] of Object.entries(checks)) {
  if (selected !== 'all' && selected !== name) continue
  try {
    await check()
    logger.info('Buckle live acceptance passed', { check: name })
  } catch (error) {
    logger.error('Buckle live acceptance failed', { check: name, message: error instanceof Error ? error.message : String(error) })
    process.exitCode = 1
  }
}

async function withFixture(check) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-acceptance-'))
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const state = join(root, 'state'); mkdirSync(state)
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end('<!doctype html><title>Buckle acceptance</title><button onclick="this.textContent=\'Clicked\'">Click me</button>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  try {
    await check({ root, workspace, state, port: address.port, url: `http://127.0.0.1:${address.port}` })
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    rmSync(root, { recursive: true, force: true })
  }
}

async function checkBrowser() {
  await withFixture(async ({ workspace, state, url, port }) => {
    const runtime = await createRuntime({ config: loadConfig({
      BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: state, BUCKLE_PACKS: 'browser',
      BUCKLE_AGENT_BROWSER_COMMAND: process.env.BUCKLE_AGENT_BROWSER_COMMAND ?? 'agent-browser',
      BUCKLE_ALLOWED_HOSTS: '127.0.0.1', BUCKLE_DEFAULT_TIMEOUT_MS: '30000',
    }), channel: () => createDeferredApprovalChannel() })
    assert.deepEqual(runtime.registry().capabilities().map(tool => tool.name), ['browser_command'])
    const sessionId = 'browser-acceptance'
    runtime.grants.grant({ sessionId, rule: 'network_egress', subject: `127.0.0.1:${port}`, scope: 'session' })
    let sequence = 0
    const call = async (command, args = []) => {
      const result = await runtime.invoke({ sessionId, request: { requestId: `browser-acceptance-${++sequence}`, tool: 'browser_command', args: { command, args }, approvalTokens: [] } })
      assert.equal(result.outcome, 'ok', JSON.stringify(result))
      return JSON.stringify(result.output)
    }
    try {
      await call('open', [url])
      await call('click', ['button'])
      assert.match(await call('snapshot'), /Clicked/)
      await call('eval', ["localStorage.setItem('buckleAcceptance', 'stored-marker')"])
      assert.match(await call('eval', ["localStorage.getItem('buckleAcceptance')"]), /stored-marker/)
      await call('close')
      await call('open', [url])
      assert.match(await call('eval', ["localStorage.getItem('buckleAcceptance') === null ? 'fresh-marker' : 'stale-marker'"]), /fresh-marker/)
    } finally {
      try { await call('close') } catch (error) {
        logger.warn('Acceptance browser cleanup failed', { message: error instanceof Error ? error.message : String(error) })
        process.exitCode = 1
      }
    }
  })
}

async function checkSandbox() {
  const { sandbox, unavailableReason } = resolveSandbox({ requested: 'bubblewrap', acknowledgedUnsandboxed: false })
  assert.equal(sandbox.mode, 'bubblewrap', unavailableReason ?? 'Bubblewrap is required')
  await withFixture(async ({ root, workspace, state, url }) => {
    const outside = join(root, 'outside'); writeFileSync(outside, 'synthetic outside marker')
    writeFileSync(join(workspace, '.env'), 'SYNTHETIC=private')
    writeFileSync(join(workspace, 'file'), 'before')
    const history = createChangeHistory({ directory: join(state, 'history'), excluded: [state], maxBytes: 1_048_576, retentionDays: 30 })
    const pack = createShellPack({ paths: createPathView({ root: workspace, mount: '/workspace' }), sandbox,
      isolation: { directory: join(state, 'isolated-shell'), maxBytes: 1_048_576, history },
      writableRoots: [workspace], hiddenPaths: [state], readOnlyPaths: [], unavailableReason: null, runProcess })
    let sequence = 0
    const execute = async script => {
      const result = await pack.tools.find(tool => tool.capability.name === 'script_run').prepare({ runtime: 'node', script }).execute({ requestId: `sandbox-acceptance-${++sequence}`, sessionId: 'sandbox-acceptance', stageId: 'sandbox-stage', timeoutMs: 4000, signal: new AbortController().signal })
      assert.equal(result.exitCode, 0, JSON.stringify(result))
      assert.equal(result.timedOut, false, JSON.stringify(result))
      return result
    }
    await execute(`
      import assert from 'node:assert/strict';
      import { readFileSync, writeFileSync } from 'node:fs';
      assert.throws(() => readFileSync('/workspace/.env'));
      assert.throws(() => readFileSync(${JSON.stringify(outside)}));
      await assert.rejects(fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(500) }));
      writeFileSync('/workspace/file', 'after');
    `)
    assert.equal(readFileSync(join(workspace, 'file'), 'utf8'), 'after')
    await history.restoreStage('sandbox-stage', 'sandbox-acceptance')
    assert.equal(readFileSync(join(workspace, 'file'), 'utf8'), 'before')
    const started = Date.now()
    await execute(`
      import { spawn } from 'node:child_process';
      spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'inherit' });
      process.exit(0);
    `)
    assert(Date.now() - started < 3000, 'Descendant pipes remained open after the main command exited')
  })
}
