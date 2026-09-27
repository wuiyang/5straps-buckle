import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ApprovalRequest } from '@5straps/protocol'
import { describe, expect, it, vi } from 'vitest'
import { createFileActionLog } from '../common/adapters/action-log/file-action-log.js'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { createWaitingApprovalChannel } from '../common/adapters/approval/waiting-approval-channel.js'
import { actionsPath, approvalsPath, grantsPath, loadConfig, type BuckleConfig } from '../common/runtime/config.js'
import { watchApprovals } from '../cli/approvals-watch.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { createApprovalRegistry, type ApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import type { ActionLog } from '../common/types/ports/action-log.js'

const POLL = { first: 20, idle: 50 }

function node(): BuckleConfig {
  return loadConfig({
    BUCKLE_WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), 'buckle-watch-')),
    BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'buckle-watch-state-')),
    BUCKLE_ALLOW_SHELL: 'false',
  })
}

/** A second registry over the node's state files, which is what a second terminal holds. */
function registryOf(config: BuckleConfig): ApprovalRegistry {
  return createApprovalRegistry(createFileGrantStore({ filePath: grantsPath(config), workspace: config.cwd }), approvalsPath(config), config.cwd)
}

function issue(registry: ApprovalRegistry): string {
  const [request] = registry.issue({
    tool: 'fs_write', sessionId: 'chat-1',
    asks: [{ kind: 'ask', rule: 'write_scope', subject: '/outside/report.md', reason: 'outside the workspace', offeredScopes: ['once', 'session'] }],
  })
  return request!.token
}

/** A terminal readline treats as a keyboard, so Ctrl-C arrives as a key press, not a signal. */
function keyboardTerminal() {
  const input = new PassThrough()
  const output = new PassThrough()
  const errors = new PassThrough()
  Object.assign(output, { isTTY: true, columns: 200, rows: 24 })
  let shown = ''
  let refused = ''
  output.on('data', (chunk: Buffer) => { shown += chunk.toString('utf8') })
  errors.on('data', (chunk: Buffer) => { refused += chunk.toString('utf8') })
  return { input, output, errors, shown: () => shown, refused: () => refused, type: (keys: string) => input.write(keys) }
}

/** An action log of its own, for a watch whose audit the test does not read. */
const scratchLog = () => createFileActionLog(join(mkdtempSync(join(tmpdir(), 'buckle-watch-log-')), 'actions.jsonl'))

function watch(approvals: Pick<ApprovalRegistry, 'pending' | 'resolve'>, terminal = keyboardTerminal(), actions: ActionLog = scratchLog()) {
  const done = watchApprovals({ approvals, actions, workspaceId: 'default', input: terminal.input, output: terminal.output, errors: terminal.errors, pollMs: POLL })
  return { terminal, done }
}

const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** A question takes keys only after the keyboard has been still with it on screen, so wait for its prompt. */
async function prompted(terminal: ReturnType<typeof keyboardTerminal>, times = 1) {
  await vi.waitFor(() => expect(count(terminal.shown(), /n\) skip > /g)).toBe(times), { timeout: 3_000 })
}

/** A private address web_fetch asks about, which offers the persisted scope too. */
function issuePrivate(registry: ApprovalRegistry, subject: string): string {
  const [request] = registry.issue({
    tool: 'web_fetch', sessionId: 'chat-1',
    asks: [{ kind: 'ask', rule: 'network_egress', subject, reason: `${subject} is private`, offeredScopes: ['once', 'session', 'always'] }],
  })
  return request!.token
}

const grantsOf = (config: BuckleConfig) => createFileGrantStore({ filePath: grantsPath(config), workspace: config.cwd }).list()

describe('buckle approvals --watch', () => {
  it('answers a waiting approval, and the gated tool call proceeds', async () => {
    const config = node()
    const outside = mkdtempSync(join(tmpdir(), 'buckle-watch-outside-'))
    const runtime = await createRuntime({ config, channel: approvals => createWaitingApprovalChannel({ approvals, timeoutMs: 10_000 }) })
    const call = runtime.invoke({ request: { requestId: 'write', tool: 'fs_write', args: { path: join(outside, 'note.md'), content: 'hello' }, approvalTokens: [] }, sessionId: 'chat-1' })

    const { terminal, done } = watch(registryOf(config))
    await vi.waitFor(() => expect(terminal.shown()).toContain('fs_write needs approval'))
    await prompted(terminal)
    expect(terminal.shown()).toContain('o) once  s) session  always) always  d) deny  n) skip')
    terminal.type('s\r')

    expect(await call).toMatchObject({ outcome: 'ok' })
    expect(readFileSync(join(outside, 'note.md'), 'utf8')).toBe('hello')
    expect(terminal.shown()).toContain('Approved (session)')
    terminal.type('\x03')
    expect(await done).toEqual({ exitCode: 0 })
  })

  it('leaves a skipped request waiting, and does not ask about it again', async () => {
    const config = node()
    const token = issue(registryOf(config))
    const { terminal, done } = watch(registryOf(config))
    await prompted(terminal)

    terminal.type('n\r')
    await vi.waitFor(() => expect(terminal.shown()).toContain(`Skipped; still waiting. Answer later with: buckle approve ${token}`))
    await new Promise(resolve => setTimeout(resolve, 200))

    expect(registryOf(config).pending().map(request => request.token)).toEqual([token])
    expect(count(terminal.shown(), /needs approval/g)).toBe(1)
    terminal.type('\x03')
    expect(await done).toEqual({ exitCode: 0 })
  })

  it('grants nothing on Enter or an unrecognised key, and keeps asking', async () => {
    const config = node()
    const token = issue(registryOf(config))
    const { terminal, done } = watch(registryOf(config))
    await prompted(terminal)

    // `a` is not a key for this request, which offers once and session alone.
    for (const [index, keys] of ['\r', 'y\r', 'a\r'].entries()) {
      terminal.type(keys)
      await vi.waitFor(() => expect(count(terminal.shown(), /Nothing granted/g)).toBe(index + 1))
    }

    expect(registryOf(config).pending().map(request => request.token)).toEqual([token])
    expect(createFileGrantStore({ filePath: grantsPath(config), workspace: config.cwd }).list()).toEqual([])
    terminal.type('\x03')
    expect(await done).toEqual({ exitCode: 0 })
    expect(registryOf(config).pending().map(request => request.token)).toEqual([token])
  })

  it('denies with d, through the same resolution as buckle approve --deny', async () => {
    const config = node()
    const token = issue(registryOf(config))
    const { terminal, done } = watch(registryOf(config))
    await prompted(terminal)

    terminal.type('d\r')
    await vi.waitFor(() => expect(terminal.shown()).toContain(`Denied ${token}`))

    expect(registryOf(config).pending()).toEqual([])
    expect(registryOf(config).resolve({ token, approved: true, scope: 'session' })).toMatchObject({ ok: false })
    terminal.type('\x03')
    await done
  })

  it('drops a question whose request expires while it is on screen', async () => {
    const expiring: ApprovalRequest = {
      token: 'expiring', rule: 'read_scope', subject: '/shots', reason: 'outside the sandbox', tool: 'fs_read',
      offeredScopes: ['once'], expiresAt: new Date(Date.now() + 300).toISOString(),
    }
    const resolve = vi.fn()
    const { terminal, done } = watch({ pending: () => [expiring].filter(request => Date.parse(request.expiresAt) > Date.now()), resolve })

    await vi.waitFor(() => expect(terminal.shown()).toContain('expiring expired; dropped.'))
    terminal.type('o\r')
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(resolve).not.toHaveBeenCalled()
    terminal.type('\x03')
    expect(await done).toEqual({ exitCode: 0 })
  })

  it('drops a question another route answered', async () => {
    const config = node()
    const token = issue(registryOf(config))
    const { terminal, done } = watch(registryOf(config))
    await vi.waitFor(() => expect(terminal.shown()).toContain('needs approval'))

    registryOf(config).resolve({ token, approved: true, scope: 'once' })

    await vi.waitFor(() => expect(terminal.shown()).toContain(`${token} was answered elsewhere; dropped.`))
    terminal.type('\x03')
    await done
  })

  it('stops on the first Ctrl-C with a question open, answering nothing', async () => {
    const config = node()
    const token = issue(registryOf(config))
    const { terminal, done } = watch(registryOf(config))
    await vi.waitFor(() => expect(terminal.shown()).toContain('needs approval'))

    terminal.type('\x03')

    expect(await done).toEqual({ exitCode: 0 })
    terminal.type('\x03')
    expect(count(terminal.shown(), /Stopped watching/g)).toBe(1)
    expect(terminal.input.listenerCount('keypress')).toBe(0)
    expect(registryOf(config).pending().map(request => request.token)).toEqual([token])
  })

  it('stops on an interrupt signal while nothing is waiting', async () => {
    const terminal = keyboardTerminal()
    const interrupted = new AbortController()
    const done = watchApprovals({ approvals: registryOf(node()), actions: scratchLog(), workspaceId: 'default', input: terminal.input, output: terminal.output, errors: terminal.errors, pollMs: POLL, signal: interrupted.signal })

    interrupted.abort()

    expect(await done).toEqual({ exitCode: 0 })
    expect(count(terminal.shown(), /Stopped watching/g)).toBe(1)
  })

  it('exits non-zero with a clear error when the node\'s approvals cannot be read', async () => {
    const config = node()
    writeFileSync(approvalsPath(config), '{ not json')
    const { terminal, done } = watch(registryOf(config))

    expect(await done).toEqual({ exitCode: 1 })
    expect(terminal.refused()).toContain('Cannot read the approvals waiting in workspace default')
    expect(terminal.refused()).toContain('BUCKLE_STATE_DIR')
    expect(existsSync(approvalsPath(config))).toBe(true)
  })
})

describe('buckle approvals --watch, audit', () => {
  it('audits each answer on its own, as buckle approve does', async () => {
    const config = node()
    const registry = registryOf(config)
    issuePrivate(registry, '10.0.0.1')
    await sleep(5)
    const second = issuePrivate(registry, '10.0.0.2')
    const actions = createFileActionLog(actionsPath(config))
    const { terminal, done } = watch(registryOf(config), keyboardTerminal(), actions)

    await prompted(terminal)
    terminal.type('always\r')
    await prompted(terminal, 2)
    terminal.type('d\r')
    await vi.waitFor(() => expect(terminal.shown()).toContain(`Denied ${second}`))
    terminal.type('\x03')
    await done

    const results = actions.read(50).filter(entry => entry.tool === 'cli_approve' && entry.event === 'result')
    expect(results).toHaveLength(2)
    expect(results.map(entry => [entry.workspaceId, entry.sessionId, entry.outcome])).toEqual([['default', 'local-owner', 'ok'], ['default', 'local-owner', 'ok']])
    expect(actions.read(50).filter(entry => entry.tool === 'cli_approve' && entry.event === 'attempt')).toHaveLength(2)
    expect(grantsOf(config).map(grant => [grant.subject, grant.scope])).toEqual([['10.0.0.1', 'always']])
  })
})

describe('buckle approvals --watch, keys meant for another question', () => {
  it('lets no key typed just after a drop answer the next request, which waits for a bare Enter', async () => {
    const config = node()
    const registry = registryOf(config)
    const first = issuePrivate(registry, '10.0.0.1')
    await sleep(5)
    const second = issuePrivate(registry, '10.0.0.2')
    const { terminal, done } = watch(registryOf(config))
    await prompted(terminal)
    expect(terminal.shown()).toContain('subject: 10.0.0.1')

    registry.resolve({ token: first, approved: false, scope: 'once' })
    await vi.waitFor(() => expect(terminal.shown()).toContain(`${first} was answered elsewhere; dropped.`))
    // Reaction time: the owner was answering the first question when it went.
    await sleep(250)
    terminal.type('always\r')
    await sleep(700)

    expect(grantsOf(config)).toEqual([])
    expect(terminal.shown()).not.toContain('subject: 10.0.0.2')
    expect(terminal.shown()).toContain('Ignored; that answered nothing.')

    terminal.type('\r')
    await prompted(terminal, 2)
    expect(terminal.shown()).toContain('subject: 10.0.0.2')
    terminal.type('d\r')
    await vi.waitFor(() => expect(terminal.shown()).toContain(`Denied ${second}`))
    expect(grantsOf(config)).toEqual([])
    terminal.type('\x03')
    expect(await done).toEqual({ exitCode: 0 })
  })

  it('grants nothing from a bare Enter and the rest of the answer typed in the same keystrokes after a drop', async () => {
    const config = node()
    const registry = registryOf(config)
    const first = issuePrivate(registry, '10.0.0.1')
    await sleep(5)
    const second = issuePrivate(registry, '10.0.0.2')
    const { terminal, done } = watch(registryOf(config))
    await prompted(terminal)

    registry.resolve({ token: first, approved: false, scope: 'once' })
    await vi.waitFor(() => expect(terminal.shown()).toContain(`${first} was answered elsewhere; dropped.`))
    // The Enter passes the gate, but `always` lands before the next question takes keys.
    terminal.type('\ralways\r')
    await prompted(terminal, 2)
    await sleep(100)

    expect(terminal.shown()).toContain('subject: 10.0.0.2')
    expect(grantsOf(config)).toEqual([])
    expect(registryOf(config).pending().map(request => request.token)).toEqual([second])
    terminal.type('\x03')
    expect(await done).toEqual({ exitCode: 0 })
  })

  it('keeps no answer history, so Up then Enter on the next question grants nothing', async () => {
    const config = node()
    const registry = registryOf(config)
    issuePrivate(registry, '10.0.0.1')
    await sleep(5)
    const second = issuePrivate(registry, '10.0.0.2')
    const { terminal, done } = watch(registryOf(config))
    await prompted(terminal)

    terminal.type('always\r')
    await prompted(terminal, 2)
    expect(terminal.shown()).toContain('subject: 10.0.0.2')
    terminal.type('\x1b[A')
    terminal.type('\r')

    await vi.waitFor(() => expect(count(terminal.shown(), /Nothing granted/g)).toBe(1))
    expect(grantsOf(config).map(grant => [grant.subject, grant.scope])).toEqual([['10.0.0.1', 'always']])
    expect(registryOf(config).pending().map(request => request.token)).toEqual([second])
    terminal.type('\x03')
    expect(await done).toEqual({ exitCode: 0 })
  })

  it('does not let a double press answer two requests', async () => {
    const config = node()
    const registry = registryOf(config)
    issuePrivate(registry, '10.0.0.1')
    await sleep(5)
    const second = issuePrivate(registry, '10.0.0.2')
    const { terminal, done } = watch(registryOf(config))
    await prompted(terminal)

    // `a` alone is not the persisted scope, so twice in a row grants nothing at all.
    terminal.type('a\r')
    await new Promise(resolve => setImmediate(resolve))
    terminal.type('a\r')
    await vi.waitFor(() => expect(count(terminal.shown(), /Nothing granted/g)).toBe(2))
    expect(grantsOf(config)).toEqual([])

    terminal.type('always\r')
    await new Promise(resolve => setImmediate(resolve))
    terminal.type('always\r')
    await sleep(200)

    expect(grantsOf(config).map(grant => [grant.subject, grant.scope])).toEqual([['10.0.0.1', 'always']])
    expect(registryOf(config).pending().map(request => request.token)).toEqual([second])
    // The first question was asked three times, so the second one's prompt is the fourth.
    await prompted(terminal, 4)
    expect(terminal.shown()).toContain('subject: 10.0.0.2')
    terminal.type('\x03')
    expect(await done).toEqual({ exitCode: 0 })
    expect(registryOf(config).pending().map(request => request.token)).toEqual([second])
  })

  it('throws away a line typed before the question took keys', async () => {
    const config = node()
    const token = issuePrivate(registryOf(config), '10.0.0.1')
    const { terminal, done } = watch(registryOf(config))
    await vi.waitFor(() => expect(terminal.shown()).toContain('subject: 10.0.0.1'))

    terminal.type('o')
    await prompted(terminal)
    terminal.type('\r')

    await vi.waitFor(() => expect(count(terminal.shown(), /Nothing granted/g)).toBe(1))
    expect(grantsOf(config)).toEqual([])
    expect(registryOf(config).pending().map(request => request.token)).toEqual([token])
    terminal.type('\x03')
    await done
  })
})

it.each([['ds', 'session'], ['da', 'always']] as const)('offers sensitive-file warning choices and persists %s denial', async (key, scope) => {
  const config = node()
  const registry = registryOf(config)
  registry.issue({ tool: 'fs_read', sessionId: 'chat-1', asks: [{ kind: 'ask', rule: 'sensitive_path', subject: '/workspace/.env.local', reason: 'WARNING: exposes credentials', offeredScopes: ['once'] }] })
  const { terminal, done } = watch(registry)
  try {
    await prompted(terminal)
    expect(terminal.shown()).toContain('WARNING')
    expect(terminal.shown()).toContain('o) allow once')
    expect(terminal.shown()).toContain('ds) deny this session')
    expect(terminal.shown()).toContain('da) always deny')
    terminal.type(`${key}\n`)
    await vi.waitFor(() => expect(registry.pending()).toHaveLength(0))
    const grants = createFileGrantStore({ filePath: grantsPath(config), workspace: config.cwd })
    expect(grants.list()).toContainEqual(expect.objectContaining({ denied: true, scope, subject: '/workspace/.env.local' }))
  } finally { terminal.type('\x03'); await done }
})
