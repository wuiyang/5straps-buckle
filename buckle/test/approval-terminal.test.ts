import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { CliRequest, RequestCli } from '@5straps/runtime'
import { APPROVAL_NO_DEADLINE, type ApprovalDecision, type ApprovalRequest, type ApprovalWait } from '@5straps/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setupCli } from '../cli/setup.js'
import { describeLocalExpiry, remainingMs } from '../common/domain/approval-deadline.js'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { createApprovalRegistry, type ApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import { createApprovalService, questionFor } from '../common/services/approvals/approval-service.js'
import { describeApprovalRequest, printable } from '../common/domain/approval-instruction.js'
import { approvalBlock, createTerminalConsumer, describeQuestion, interruptSelf, type InterruptTarget } from '../cli/terminal-consumer.js'
import { actionPhrase } from '../common/domain/action-phrase.js'
import { createConsoleWriter } from '../common/runtime/console.js'
import type { ApprovalHold } from '../common/services/approvals/interaction.js'
import { SPAWN_TEST_TIMEOUT_MS } from './spawn-timeout.js'
import { runsNativeTerminal } from './support/native-terminal.js'

// The rows that pin cursor control run on a capable terminal whatever shell runs the suite; the TERM=dumb rows say so.
beforeEach(() => { vi.stubEnv('TERM', 'xterm-256color') })
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })

function approval(token: string, expiresInMs = 60_000): ApprovalRequest {
  return {
    token,
    rule: 'read_scope',
    subject: '/shots',
    reason: 'outside the sandbox',
    tool: 'fs_read',
    offeredScopes: ['once', 'session', 'always'],
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  }
}

/** The whole call an ask recorded, which every question of this build carries (owner decision D17). */
const recordedCall = { arguments: { path: '/shots/a.png' }, cwd: '/workspace', description: 'Read "/shots/a.png"', effects: ['read /shots/a.png'], complete: true as const }

/** The question the approval service puts to the terminal for one request. */
function question(token: string, expiresInMs = 60_000): CliRequest {
  return questionFor({ approval: approval(token, expiresInMs), workspaceId: 'default', context: { correlationId: `c-${token}`, sessionId: 's', call: recordedCall } })
}

/** A terminal nobody answers: the streams are open, and no keystroke ever arrives. */
function silentTerminal() {
  const input = new PassThrough()
  const output = new PassThrough()
  let shown = ''
  output.on('data', (chunk: Buffer) => { shown += chunk.toString('utf8') })
  return { input, output, shown: () => shown }
}

/** A terminal readline treats as a keyboard, so Ctrl-C arrives as a key press, not a signal. */
function keyboardTerminal() {
  const terminal = silentTerminal()
  Object.assign(terminal.output, { isTTY: true, columns: 80, rows: 24 })
  return terminal
}

/**
 * The durable queue as the service reads it: `pending` drops an expired request, and another route
 * answering is a token leaving the queue.
 */
function stubQueue(requests: ApprovalRequest[]) {
  let pending = [...requests]
  const resolved: ApprovalDecision[] = []
  const registry = {
    ask: async () => ({ requests, joined: false, answered: [] }),
    pending: vi.fn(() => pending.filter(request => remainingMs(request.expiresAt) > 0)),
    wasDenied: (tokens: string[]) => resolved.some(decision => tokens.includes(decision.token) && !decision.approved),
    resolve: async (decision: ApprovalDecision) => {
      resolved.push(decision)
      pending = pending.filter(request => request.token !== decision.token)
      return { ok: true }
    },
    cancel: async (tokens: string[]) => {
      const withdrawn = pending.filter(request => tokens.includes(request.token)).map(request => request.token)
      pending = pending.filter(request => !tokens.includes(request.token))
      return withdrawn
    },
    sweep: async () => undefined,
    sweepIfDue: async () => undefined,
  }
  return { registry: registry as unknown as ApprovalRegistry, pending: registry.pending, resolved, answerElsewhere: (token: string) => { pending = pending.filter(request => request.token !== token) } }
}

const nobody: RequestCli = async request => ({ status: 'unavailable', requestId: request.id, reason: 'no_consumer' })

function waitingService(input: { registry: ApprovalRegistry; graceMs: number | null; requestCli?: RequestCli; hold?: ApprovalHold; announce?: (requests: ApprovalRequest[]) => Promise<void> }) {
  const service = createApprovalService({ registry: input.registry, workspaceId: 'default', serverId: 'test-node', graceMs: input.graceMs, interaction: async () => ({ requestCli: input.requestCli ?? nobody, hold: input.hold ?? 'grace' }), ...(input.announce ? { announce: input.announce } : {}) })
  return (tokens = 1, wait?: ApprovalWait) => service.request({ sessionId: 's', requestId: 'r', tool: 'fs_read', call: recordedCall, asks: Array.from({ length: tokens }, () => ({ kind: 'ask' as const, rule: 'read_scope' as const, subject: '/shots', reason: 'outside the sandbox', offeredScopes: ['once' as const, 'session' as const, 'always' as const] })), ...(wait ? { wait } : {}) })
}

/** A question held on screen until the test answers it, recording whether it was withdrawn. */
function heldQuestion() {
  let answer: (choice: string) => void = () => undefined
  let withdrawn = false
  const requestCli: RequestCli = (request, options) => new Promise(resolve => {
    answer = choice => resolve({ status: 'answered', requestId: request.id, answer: { choice } })
    options?.signal?.addEventListener('abort', () => { withdrawn = true; resolve({ status: 'cancelled', requestId: request.id, reason: 'withdrawn' }) })
  })
  return { requestCli, answer: (choice: string) => answer(choice), withdrawn: () => withdrawn }
}

describe('the grace period before a gated call gives up', () => {
  it('returns as soon as another route resolves the approval', async () => {
    const queue = stubQueue([approval('t1')])
    setTimeout(() => queue.answerElsewhere('t1'), 50)
    const started = Date.now()
    expect(await waitingService({ registry: queue.registry, graceMs: 5_000 })()).toMatchObject({ settled: true })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('gives up once the grace period passes, so a call is not held forever', async () => {
    expect(await waitingService({ registry: stubQueue([approval('t1')]).registry, graceMs: 600 })()).toMatchObject({ settled: false })
  })

  it('returns at once when the caller\'s hint says none, and still asks the terminal (owner ruling of 2026-09-28)', async () => {
    const queue = stubQueue([approval('t1')])
    const requestCli = vi.fn(nobody)
    expect(await waitingService({ registry: queue.registry, graceMs: 60_000, requestCli })(1, { mode: 'none' })).toMatchObject({ settled: false })
    await vi.waitFor(() => expect(requestCli).toHaveBeenCalledTimes(1))
  })

  it('waits for every token, not just the first one answered', async () => {
    const queue = stubQueue([approval('t1'), approval('t2')])
    setTimeout(() => queue.answerElsewhere('t1'), 50)
    let settledEarly = false
    setTimeout(() => { settledEarly = queue.pending().length === 0 }, 200)
    setTimeout(() => queue.answerElsewhere('t2'), 300)
    expect(await waitingService({ registry: queue.registry, graceMs: 3_000 })(2)).toMatchObject({ settled: true })
    expect(settledEarly).toBe(false)
  })

  it('announces the request before waiting, so someone can be reached in time', async () => {
    const announce = vi.fn(async () => undefined)
    await waitingService({ registry: stubQueue([]).registry, graceMs: 1_000, announce })()
    expect(announce).toHaveBeenCalledOnce()
  })

  it('schedules no expiry sweep for a call that issued no ask (review L6)', async () => {
    const warn = vi.spyOn(process, 'emitWarning')
    try {
      await waitingService({ registry: stubQueue([]).registry, graceMs: 50 })()
      expect(warn.mock.calls.filter(([, type]) => String(type) === 'TimeoutNegativeWarning')).toEqual([])
    } finally { warn.mockRestore() }
  })

  it('still waits when announcing fails, rather than failing the call itself', async () => {
    expect(await waitingService({ registry: stubQueue([]).registry, graceMs: 1_000, announce: async () => { throw new Error('telegram is down') } })()).toMatchObject({ settled: true })
  })

  it('takes a terminal answer when one arrives first, for the token its question asked about', async () => {
    const queue = stubQueue([approval('t1')])
    const requestCli: RequestCli = async request => ({ status: 'answered', requestId: request.id, answer: { choice: 'session' } })
    expect(await waitingService({ registry: queue.registry, graceMs: 5_000, requestCli })()).toMatchObject({ settled: true })
    expect(queue.resolved).toEqual([{ token: 't1', approved: true, scope: 'session' }])
  })

  it('tells the terminal to let go once another route has answered', async () => {
    const queue = stubQueue([approval('t1')])
    const held = heldQuestion()
    setTimeout(() => queue.answerElsewhere('t1'), 50)
    await waitingService({ registry: queue.registry, graceMs: 2_000, requestCli: held.requestCli })()
    await vi.waitFor(() => expect(held.withdrawn()).toBe(true))
  })
})

describe('the terminal question after the grace period', () => {
  it('stays open past the grace deadline while the call reports back', async () => {
    vi.useFakeTimers()
    const held = heldQuestion()
    const waiting = waitingService({ registry: stubQueue([approval('t1')]).registry, graceMs: 200, requestCli: held.requestCli })()
    await vi.advanceTimersByTimeAsync(200)
    expect(await waiting).toMatchObject({ settled: false })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(held.withdrawn()).toBe(false)
  })

  it('records an answer given after the grace period, resolving the pending approval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-grace-'))
    const registry = createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: root }), join(root, 'approvals.json'), root)
    const held = heldQuestion()
    const result = await waitingService({ registry, graceMs: 200, requestCli: held.requestCli })()
    expect(result).toMatchObject({ settled: false })
    const [issued] = result.approvals
    expect(registry.pending().map(entry => entry.token)).toEqual([issued!.token])
    held.answer('session')
    await vi.waitFor(() => expect(registry.pending()).toEqual([]))
    // The terminal's answer is the one on record: the same answer again changes nothing.
    expect(await registry.resolve({ token: issued!.token, approved: true, scope: 'session' })).toEqual({ ok: true, repeated: true, asked: { rule: 'read_scope', subject: '/shots' } })
  })

  it('closes once the request expires', async () => {
    vi.useFakeTimers()
    const held = heldQuestion()
    const waiting = waitingService({ registry: stubQueue([approval('t1', 700)]).registry, graceMs: 200, requestCli: held.requestCli })()
    await vi.advanceTimersByTimeAsync(200)
    expect(await waiting).toMatchObject({ settled: false })
    expect(held.withdrawn()).toBe(false)
    // Past the expiry, the next poll finds the request gone.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(held.withdrawn()).toBe(true)
  })

  it('closes once another route answers after the grace period', async () => {
    const queue = stubQueue([approval('t1')])
    const held = heldQuestion()
    expect(await waitingService({ registry: queue.registry, graceMs: 200, requestCli: held.requestCli })()).toMatchObject({ settled: false })
    queue.answerElsewhere('t1')
    await vi.waitFor(() => expect(held.withdrawn()).toBe(true), { timeout: 2_000 })
  })
})

describe('the terminal, attached to the process\'s one requester', () => {
  it('answers unavailable without a terminal, rather than blocking on a pipe', async () => {
    expect(await setupCli({ terminal: null }).requestCli(question('t1'))).toMatchObject({ status: 'unavailable', reason: 'no_consumer' })
  })

  it('gives up on a question once its own request expires, rather than holding the terminal', async () => {
    const terminal = silentTerminal()
    expect(await setupCli({ terminal }).requestCli(question('t1', 300))).toMatchObject({ status: 'timed_out' })
    expect(terminal.shown()).toContain('expires in')
  })

  it('asks the next queued question after one expires, so a live request is still answerable', async () => {
    const terminal = silentTerminal()
    const cli = setupCli({ terminal })
    const first = cli.requestCli(question('expiring', 300))
    const second = cli.requestCli(question('live', 600))
    expect(await first).toMatchObject({ status: 'timed_out' })
    expect(await second).toMatchObject({ status: 'timed_out' })
    // Both questions reached the terminal, which is what a held terminal would have stopped.
    expect(terminal.shown()).toContain('outside the sandbox')
    expect(terminal.shown().match(/needs approval/g)).toHaveLength(2)
  })

  it('does not show a question whose request expired before its turn', async () => {
    const terminal = silentTerminal()
    expect(await setupCli({ terminal }).requestCli(question('stale', -1_000))).toMatchObject({ status: 'timed_out' })
    expect(terminal.shown()).toBe('')
  })

  it('declines a question cancelled before its turn without touching the terminal', async () => {
    const terminal = silentTerminal()
    const controller = new AbortController()
    controller.abort()
    expect(await setupCli({ terminal }).requestCli(question('t1'), { signal: controller.signal })).toMatchObject({ status: 'cancelled' })
    expect(terminal.input.listenerCount('data')).toBe(0)
    expect(terminal.shown()).toBe('')
  })
})

describe('keys meant for another terminal question', () => {
  const prompts = (terminal: ReturnType<typeof keyboardTerminal>) => terminal.shown().match(/Your choice: /g)?.length ?? 0
  const prompted = (terminal: ReturnType<typeof keyboardTerminal>, times: number) => vi.waitFor(() => expect(prompts(terminal)).toBe(times), { timeout: 3_000 })

  it('does not let a double press answer the next queued question', async () => {
    const terminal = keyboardTerminal()
    const cli = setupCli({ terminal })
    const first = cli.requestCli(question('first', 600_000))
    const second = cli.requestCli(question('second', 600_000))
    await prompted(terminal, 1)

    terminal.input.write('1\r')
    await new Promise(resolve => setImmediate(resolve))
    terminal.input.write('1\r')

    expect(await first).toMatchObject({ status: 'answered', answer: { choice: 'once' } })
    await prompted(terminal, 2)
    terminal.input.write('2\r')
    expect(await second).toMatchObject({ status: 'answered', answer: { choice: 'session' } })
  })

  it('lets no key typed just after a drop answer the next question, which still denies on Enter', async () => {
    const terminal = keyboardTerminal()
    const cli = setupCli({ terminal })
    const expiring = cli.requestCli(question('expiring', 1_000))
    const next = cli.requestCli(question('next', 600_000))
    await prompted(terminal, 1)

    expect(await expiring).toMatchObject({ status: 'timed_out' })
    // Reaction time: the owner was answering the question that just went.
    await new Promise(resolve => setTimeout(resolve, 250))
    terminal.input.write('3\r')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(prompts(terminal)).toBe(1)

    await prompted(terminal, 2)
    terminal.input.write('\r')
    expect(await next).toMatchObject({ status: 'answered', answer: { choice: 'deny' } })
  })

  it('drops a question cancelled while it waited its turn, without showing it', async () => {
    const terminal = keyboardTerminal()
    const cli = setupCli({ terminal })
    const first = cli.requestCli(question('first', 600_000))
    const cancelling = new AbortController()
    const queued = cli.requestCli(question('queued', 600_000), { signal: cancelling.signal })
    await prompted(terminal, 1)

    cancelling.abort()
    expect(await queued).toMatchObject({ status: 'cancelled' })
    terminal.input.write('1\r')
    expect(await first).toMatchObject({ status: 'answered', answer: { choice: 'once' } })
    await new Promise(resolve => setImmediate(resolve))
    expect(terminal.shown().match(/needs approval/g)).toHaveLength(1)
  })

  it('throws away keys typed while no question was open', async () => {
    const terminal = keyboardTerminal()
    const cli = setupCli({ terminal })
    terminal.input.write('3\r1')
    const asked = cli.requestCli(question('late', 600_000))
    await prompted(terminal, 1)

    terminal.input.write('\r')
    expect(await asked).toMatchObject({ status: 'answered', answer: { choice: 'deny' } })
  })

  it('shows a question without its whole call as recorded before this build, and lets no key approve it (owner decision D17)', async () => {
    const terminal = keyboardTerminal()
    const cli = setupCli({ terminal })
    const asked = cli.requestCli(questionFor({ approval: approval('pre-build', 600_000), workspaceId: 'default', context: { correlationId: 'c-pre', sessionId: 's' } }))
    await prompted(terminal, 1)
    expect(terminal.shown()).toContain('recorded before this build')
    expect(terminal.shown()).not.toContain('approve once')
    terminal.input.write('1\r')
    expect(await asked).toMatchObject({ status: 'answered', answer: { choice: 'deny' } })
  })

  it('carries a terminal answer into the queue through the approval service', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-terminal-answer-'))
    const registry = createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: root }), join(root, 'approvals.json'), root)
    const terminal = keyboardTerminal()
    const call = waitingService({ registry, graceMs: 15_000, requestCli: setupCli({ terminal }).requestCli, hold: 'prompt' })()
    await prompted(terminal, 1)

    terminal.input.write('1\r')

    expect(await call).toMatchObject({ settled: true })
    expect(registry.unspent('s').map(entry => entry.subject)).toEqual([{ rule: 'read_scope', subject: '/shots' }])
  })
})

// The CLI display slice, C3: a line logged while a question is open goes through the writer the question shares with
// the log, above the prompt; on a terminal the prompt and the typed key are drawn again below it.
describe('a log line written while a terminal question is open', () => {
  it('lands above the prompt, which is drawn again with the key typed, on a terminal', async () => {
    const terminal = keyboardTerminal()
    const writer = createConsoleWriter({ output: terminal.output, dates: false })
    const asked = setupCli({ terminal: { ...terminal, console: writer } }).requestCli(question('t1', 600_000))
    await vi.waitFor(() => expect(terminal.shown()).toMatch(/Your choice: \S*$/), { timeout: 3_000 })
    terminal.input.write('2')
    await vi.waitFor(() => expect(terminal.shown()).toMatch(/2$/))
    writer.write(['22:22:05 [info] /mcp request completed (3ms)'], new Date())
    expect(terminal.shown()).toContain('\u001b[2K\u001b[1G22:22:05 [info] /mcp request completed (3ms)\n')
    expect(terminal.shown().split('22:22:05 [info] /mcp request completed (3ms)\n')[1]).toMatch(/Your choice: \S*2/)
    terminal.input.write('\r')
    expect(await asked).toMatchObject({ status: 'answered', answer: { choice: 'session' } })
  })

  // Under TERM=dumb a terminal prints the escapes as text and the typed answer scrolls out of view: no escape is sent.
  it('lands on its own line under TERM=dumb, the prompt and the key typed written again below it, and no escape sent', async () => {
    vi.stubEnv('TERM', 'dumb')
    const terminal = keyboardTerminal()
    const writer = createConsoleWriter({ output: terminal.output, dates: false })
    const asked = setupCli({ terminal: { ...terminal, console: writer } }).requestCli(question('t1', 600_000))
    await vi.waitFor(() => expect(terminal.shown()).toMatch(/Your choice: \S*$/), { timeout: 3_000 })
    terminal.input.write('2')
    await vi.waitFor(() => expect(terminal.shown()).toMatch(/Your choice: 2$/))
    writer.write(['22:22:05 [info] /mcp request completed (3ms)'], new Date())
    expect(terminal.shown()).toMatch(/Your choice: 2\n22:22:05 \[info\] \/mcp request completed \(3ms\)\n\[default\] Your choice: 2$/)
    terminal.input.write('\r')
    expect(await asked).toMatchObject({ status: 'answered', answer: { choice: 'session' } })
    expect(terminal.shown()).not.toContain('\u001b')
  })

  it('is written plainly where the output is no terminal', async () => {
    const terminal = silentTerminal()
    const writer = createConsoleWriter({ output: terminal.output, dates: false })
    const stop = new AbortController()
    const asked = createTerminalConsumer({ ...terminal, console: writer, onInterrupt: () => {} }).prompt(question('t1', 600_000), { signal: stop.signal })
    await vi.waitFor(() => expect(terminal.shown()).toMatch(/Your choice: $/), { timeout: 3_000 })
    writer.write(['22:22:05 [info] plain'], new Date())
    stop.abort()
    await asked.catch(() => undefined)
    expect(terminal.shown()).toContain('Your choice: 22:22:05 [info] plain\n')
    expect(terminal.shown()).not.toContain('\u001b')
  })
})

describe('the process interrupting itself after Ctrl-C at a question', () => {
  const target = (listeners: number) => ({ pid: 4321, kill: vi.fn(), listenerCount: vi.fn(() => listeners), emit: vi.fn(), exit: vi.fn() }) satisfies InterruptTarget

  it('raises SIGINT again on Linux and macOS', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const process = target(1)
      interruptSelf(platform, process)
      expect(process.kill).toHaveBeenCalledWith(4321, 'SIGINT')
      expect(process.emit).not.toHaveBeenCalled()
    }
  })

  it('runs the SIGINT listeners directly on Windows, where a signal to itself would end it before any close step', () => {
    const process = target(1)
    interruptSelf('win32', process)
    expect(process.emit).toHaveBeenCalledWith('SIGINT', 'SIGINT')
    expect(process.kill).not.toHaveBeenCalled()
    expect(process.exit).not.toHaveBeenCalled()
  })

  it('exits as an interrupted process on Windows when nothing listens for SIGINT', () => {
    const process = target(0)
    interruptSelf('win32', process)
    expect(process.exit).toHaveBeenCalledWith(130)
    expect(process.kill).not.toHaveBeenCalled()
  })
})

describe('Ctrl-C at a terminal question', () => {
  it('drops the open question and every queued one, and stops the process once', async () => {
    const terminal = keyboardTerminal()
    const onInterrupt = vi.fn()
    const cli = setupCli({ terminal: { ...terminal, onInterrupt } })
    const open = cli.requestCli(question('open', 600_000))
    const queued = [cli.requestCli(question('queued-1', 600_000)), cli.requestCli(question('queued-2', 600_000))]
    await vi.waitFor(() => expect(terminal.shown()).toContain('needs approval'))

    terminal.input.write('\x03')

    expect(await open).toMatchObject({ status: 'unavailable', reason: 'consumer_detached' })
    expect(await Promise.all(queued)).toEqual([
      expect.objectContaining({ status: 'unavailable', reason: 'consumer_detached' }),
      expect.objectContaining({ status: 'unavailable', reason: 'consumer_detached' }),
    ])
    expect(onInterrupt).toHaveBeenCalledTimes(1)
    // C4: Ctrl-C tags no row; the shutdown lines follow.
    expect(terminal.shown()).not.toMatch(/\[(timeout|stopped|no longer waiting)\]/)
    // Only the first question was ever shown; the queued ones were dropped, not asked in turn.
    expect(terminal.shown().match(/needs approval/g)).toHaveLength(1)
    // The readline is closed: it no longer listens for key presses on the terminal.
    expect(terminal.input.listenerCount('keypress')).toBe(0)
    // A request arriving after Ctrl-C is not asked while the process stops.
    expect(await cli.requestCli(question('late', 600_000))).toMatchObject({ status: 'unavailable', reason: 'no_consumer' })
    expect(onInterrupt).toHaveBeenCalledTimes(1)
  })

  it.runIf(runsNativeTerminal)('stops the process on the first Ctrl-C in a real terminal, with questions open and queued', async () => {
    const pty = await import('node-pty')
    const script = join(mkdtempSync(join(tmpdir(), 'buckle-ctrl-c-')), 'serve-like.mts')
    writeFileSync(script, `
      import { setupCli } from ${JSON.stringify(new URL('../cli/setup.ts', import.meta.url).href)};
      import { questionFor } from ${JSON.stringify(new URL('../common/services/approvals/approval-service.ts', import.meta.url).href)};
      const cli = setupCli({ terminal: { input: process.stdin, output: process.stderr } });
      const approval = (token) => ({ token, rule: 'read_scope', subject: '/outside', reason: 'outside the sandbox', tool: 'fs_read', offeredScopes: ['once'], expiresAt: new Date(Date.now() + 600_000).toISOString() });
      // Like buckle serve, something else keeps the process alive while the questions are open.
      setInterval(() => {}, 1_000);
      for (const token of ['a', 'b', 'c']) void cli.requestCli(questionFor({ approval: approval(token), workspaceId: 'default', context: { correlationId: token, sessionId: 's' } }));
    `)
    const child = pty.spawn(process.execPath, ['--import', import.meta.resolve('tsx'), script], {
      name: 'xterm-256color', cwd: tmpdir(), env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'xterm-256color' }, cols: 80, rows: 24,
    })
    let shown = ''
    child.onData(data => { shown += data })
    const exited = new Promise<{ exitCode: number; signal?: number }>(resolve => child.onExit(resolve))
    try {
      await expect.poll(() => shown, { timeout: SPAWN_TEST_TIMEOUT_MS / 2 }).toContain('needs approval')
      child.write('\x03')
      const stopped = await Promise.race([exited, new Promise<null>(resolve => setTimeout(() => resolve(null), 5_000))])
      expect(stopped).not.toBeNull()
      expect(stopped!.signal).toBe(2)
      expect(shown.match(/needs approval/g)).toHaveLength(1)
    } finally {
      child.kill('SIGKILL')
    }
  }, SPAWN_TEST_TIMEOUT_MS)
})

describe('what an agent chose, on the owner\'s terminal (review M3)', () => {
  // Moves up a line, erases it and rewrites the subject: on a terminal `rm -rf ~` would read as `ls -la`.
  const spoofed = 'rm -rf ~\u001b[1A\u001b[2K\r  subject: ls -la'
  const control = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e]/

  it('escapes every control character, so it shows as text and never acts', () => {
    expect(printable(spoofed)).toBe('rm -rf ~\\u001b[1A\\u001b[2K\\u000d  subject: ls -la')
    expect(printable('a\u009b2Jb\u007fc\u202ed\nf')).toBe('a\\u009b2Jb\\u007fc\\u202ed\\u000af')
    expect(printable('/workspace/plain name.md')).toBe('/workspace/plain name.md')
  })

  it('escapes format characters too: bidi marks, zero-width characters, the soft hyphen and tags (review L1 of B13-B14)', () => {
    expect(printable('notes\u200b.md')).toBe('notes\\u200b.md')
    expect(printable('a\u200eb\u200fc\u061cd\u2060e\ufefff\u00adg')).toBe('a\\u200eb\\u200fc\\u061cd\\u2060e\\ufefff\\u00adg')
    expect(printable('x\u{e0041}\u{e007f}y')).toBe('x\\u{e0041}\\u{e007f}y')
    expect(printable('caf\u00e9 \u{1f600}')).toBe('caf\u00e9 \u{1f600}')
  })

  it('shows a terminal question, and the lines sent to an MCP client, with the subject escaped', () => {
    const request = { ...approval('t1'), subject: spoofed, reason: 'outside\u001b]0;title\u0007' }
    const question = describeQuestion({ ...request, workspaceId: 'default' })
    const lines = describeApprovalRequest({ request }).join('\n')

    for (const shown of [question, lines]) {
      expect(shown).not.toMatch(control)
      expect(shown).toContain('subject: rm -rf ~\\u001b[1A')
    }
  })
})

describe('the text relayed for a waiting ask', () => {
  // D85, Q15: the workspace by its name, which the commands take, escaped as the agent's text is, and quoted as a shell word where it has to be.
  it('says where it waits: the node, and the workspace by name, its name escaped as the agent\'s text is', () => {
    const lines = describeApprovalRequest({ request: approval('t1'), workspaceId: 'site', workspaceName: 'The\u001b[2J site', nodeName: 'node-7' })
    expect(lines).toContain('waiting on node node-7, workspace The\\u001b[2J site')
    expect(lines).toContain('see the whole action with: buckle approvals --workspace \'The\\u001b[2J site\'')
  })
})

// Owner decision D17: the node's own terminal is an approver too, so it shows the whole action a question
// is about, as a person's device does: nothing cut, nothing paged.
describe('a terminal question shows the whole action (owner decision D17)', () => {
  // The workspace-model brief, item 6, and D85, Q15: the ask names its workspace by name, and every line is marked [<name>].
  it('prints the node, workspace, effects and every argument through the question\'s details, a size line first past 64 KiB', async () => {
    const script = Array.from({ length: 2_000 }, (_, index) => `echo line-${index} ${'z'.repeat(40)}`).join('\n')
    const call = { arguments: { args: ['-c', script], command: 'sh' }, cwd: '/workspace', description: 'Run "sh -c ..." in "/workspace"', effects: ['exec sh -c ...', 'write /workspace'], complete: true as const }
    const request = questionFor({ approval: { ...approval('t-full'), rule: 'destructive_command', subject: 'sh -c ...  # argv sha256 00' }, workspaceId: 'default', workspaceName: 'The site', node: 'node-1', context: { correlationId: 'c-full', sessionId: 's', call } })
    const terminal = silentTerminal()
    const stop = new AbortController()
    const asked = createTerminalConsumer({ input: terminal.input, output: terminal.output, onInterrupt: () => {} }).prompt(request, { signal: stop.signal })
    await vi.waitFor(() => expect(terminal.shown()).toContain('  arguments:'))
    stop.abort()
    await asked.catch(() => undefined)
    const lines = terminal.shown().split('\n')
    const size = lines.findIndex(line => /^\[The site\] {3}size: {5}\d+ bytes of arguments, every one shown below$/.test(line))
    expect(size).toBeGreaterThan(-1)
    expect(size).toBeLessThan(lines.findIndex(line => line.startsWith('[The site]   node:')))
    expect(lines).toContain('[The site] fs_read needs approval in workspace The site')
    for (const expected of ['  node:     node-1', '  workspace: The site', '  in:       /workspace', '  effects:  exec sh -c ...', '            write /workspace']) expect(lines).toContain(`[The site] ${expected}`)
    // C4: the head line carries the time and the [approval] tag before the mark.
    expect(lines.filter(line => line.trim() !== '' && !/^(\d\d:\d\d:\d\d \[approval\] )?\[The site\] /.test(line))).toEqual([])
    expect(terminal.shown()).toContain(JSON.stringify(script))
  })
})

// The CLI display slice, C4: the serve terminal's own layout. A head line with the time, the [approval] tag, the
// workspace, and Buckle's words for the tool; the ask and the whole action, every line marked; the choices in the
// owner's words over the offered scopes alone; a short prompt row; and what happened, written on that row.
describe('the serve terminal\'s question', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  const named = (ask: ApprovalRequest, call: typeof recordedCall | null = recordedCall) =>
    questionFor({ approval: ask, workspaceId: 'w-1', workspaceName: 'The site', node: 'node-1', context: { correlationId: 'c', sessionId: 's', ...(call ? { call } : {}) } })

  /** A question on a silent terminal, shown up to its prompt row, and a way to end it as an abort with no reason does. */
  async function shownQuestion(request: CliRequest) {
    const terminal = silentTerminal()
    const stop = new AbortController()
    const asked = createTerminalConsumer({ ...terminal, onInterrupt: () => {} }).prompt(request, { signal: stop.signal }).catch(() => undefined)
    await vi.waitFor(() => expect(terminal.shown()).toMatch(/Your choice: $/), { timeout: 3_000 })
    return { terminal, end: async () => { stop.abort(); await asked } }
  }

  it('heads it with the time, [approval], the workspace, and Buckle\'s words for the tool, every line after it marked', async () => {
    const { terminal, end } = await shownQuestion(named(approval('t1')))
    await end()
    const lines = terminal.shown().split('\n')
    expect(lines[0]).toMatch(/^\d\d:\d\d:\d\d \[approval\] \[The site\] action pending approval: read a file$/)
    expect(lines).toContain('[The site] fs_read needs approval in workspace The site')
    expect(lines).toContain('[The site]   does:     Read "/shots/a.png"')
    expect(lines.slice(1).filter(line => line !== '' && !line.startsWith('[The site] '))).toEqual([])
  })

  it('shows the expiry on this device\'s clock, while the watch and the relayed text keep ISO UTC', async () => {
    vi.stubEnv('TZ', 'Asia/Kuala_Lumpur')
    // The block's expiry and the one worded here again read one clock (fix brief 1, H8).
    vi.useFakeTimers({ toFake: ['Date'] })
    const ask = approval('t1', 600_000)
    const { terminal, end } = await shownQuestion(named(ask))
    await end()
    expect(terminal.shown()).toContain(`[The site]   ${describeLocalExpiry(ask.expiresAt)}\n`)
    expect(terminal.shown()).toMatch(/\[The site\] {3}expires in \d+m \d+s \(at (\d{4}-\d\d-\d\d )?\d\d:\d\d:\d\d\)\n/)
    expect(describeQuestion({ ...ask, workspaceName: 'The site', call: recordedCall })).toContain(`(${ask.expiresAt})`)
    expect(describeApprovalRequest({ request: ask }).join('\n')).toContain(`(${ask.expiresAt})`)
  })

  it('words the local expiry with the date where it is not today\'s', () => {
    vi.stubEnv('TZ', 'Asia/Kuala_Lumpur')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-21T14:22:02Z'))
    expect(describeLocalExpiry('2026-10-21T14:32:00.000Z')).toBe('expires in 9m 58s (at 22:32:00)')
    expect(describeLocalExpiry('2026-10-21T17:00:00.000Z')).toBe('expires in 157m 58s (at 2026-10-22 01:00:00)')
    expect(describeLocalExpiry('2026-10-21T14:00:00.000Z')).toBe('expired (at 22:00:00)')
    expect(describeLocalExpiry(APPROVAL_NO_DEADLINE)).toBe('no expiry; waiting for an owner decision')
  })

  it.each<[string, Partial<ApprovalRequest>, boolean, string]>([
    ['every scope a read outside the workspace offers', {}, true, '[The site] (1) approve once  (2) approve this session  (3) always approve  (n) deny'],
    ['no always at the destructive floor (BUCKLE-D05)', { rule: 'destructive_command', offeredScopes: ['once', 'session'] }, true, '[The site] (1) approve once  (2) approve this session  (n) deny'],
    ['once and the remembered denials for a sensitive file', { rule: 'sensitive_path', offeredScopes: ['once'] }, true, '[The site] (1) approve once  (n) deny  (ds) deny this session  (da) always deny'],
    ['the denial alone for an ask recorded before this build', {}, false, '[The site] (n) deny'],
  ])('numbers its choices over the offered scopes alone, then asks on a short row of its own: %s', async (_, change, withCall, choices) => {
    const { terminal, end } = await shownQuestion(named({ ...approval('t1'), ...change }, withCall ? recordedCall : null))
    await end()
    expect(terminal.shown()).toContain(`\n${choices}\n[The site] Your choice: `)
  })

  it.each<[string, string, string, RegExp]>([
    ['a number stays as typed', '1', 'once', /Your choice: \S*1\r\n$/],
    ['n stays as typed', 'n', 'deny', /Your choice: \S*n\r\n$/],
    ['Enter adds [deny]', '', 'deny', /Your choice: \S*\r\n\u001b\[1A\u001b\[1G\u001b\[0J\[The site\] Your choice: \[deny\]\n$/],
    ['an unknown key adds [deny]', 'x', 'deny', /Your choice: \S*x\r\n\u001b\[1A\u001b\[1G\u001b\[0J\[The site\] Your choice: x \[deny\]\n$/],
  ])('keeps the answer on its row at a terminal: %s', async (_, key, choice, row) => {
    const terminal = keyboardTerminal()
    const asked = setupCli({ terminal }).requestCli(named(approval('t1', 600_000)))
    await vi.waitFor(() => expect(terminal.shown()).toMatch(/Your choice: \S*$/), { timeout: 3_000 })
    terminal.input.write(`${key}\r`)
    expect(await asked).toMatchObject({ status: 'answered', answer: { choice } })
    await vi.waitFor(() => expect(terminal.shown()).toMatch(row))
  })

  // Fix brief 1, H2: a scope is chosen by the one digit shown beside it alone; anything else typed is not on offer and denies.
  it.each(['1x', '2n', '2 please', '3.', '1e9', '01', '3)', '1 2', '+1', '02'])('denies %j, which no choice offers, with [deny]', async (typed) => {
    const terminal = silentTerminal()
    const asked = setupCli({ terminal }).requestCli(named(approval('t1', 600_000)))
    await vi.waitFor(() => expect(terminal.shown()).toMatch(/Your choice: $/), { timeout: 3_000 })
    terminal.input.write(`${typed}\n`)
    expect(await asked).toMatchObject({ status: 'answered', answer: { choice: 'deny' } })
    await vi.waitFor(() => expect(terminal.shown().endsWith(`[The site] Your choice: ${typed} [deny]\n`)).toBe(true))
  })

  it.each<[string, Partial<ApprovalRequest>, string]>([
    ['1', {}, 'once'],
    ['2', {}, 'session'],
    ['3', {}, 'always'],
    ['3', { rule: 'destructive_command', offeredScopes: ['once', 'session'] }, 'deny'],
  ])('reads %j as the scope it numbers, and a digit beyond the offered scopes as a denial: %j', async (typed, change, choice) => {
    const terminal = silentTerminal()
    const asked = setupCli({ terminal }).requestCli(named({ ...approval('t1', 600_000), ...change }))
    await vi.waitFor(() => expect(terminal.shown()).toMatch(/Your choice: $/), { timeout: 3_000 })
    terminal.input.write(`${typed}\n`)
    expect(await asked).toMatchObject({ status: 'answered', answer: { choice } })
    await vi.waitFor(() => expect(terminal.shown().endsWith(`[The site] Your choice: ${typed}${choice === 'deny' ? ' [deny]' : ''}\n`)).toBe(true))
  })

  // Fix brief 1, H7: the workspace's name and an unknown tool's name reach the head line, every mark, and the prompt row
  // escaped; the name is the owner's, and may come from a folder's.
  const control = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e]/
  const hostileName = 'The\u001b[2J\u009b\u202e site'
  const shownName = 'The\\u001b[2J\\u009b\\u202e site'

  it('escapes a workspace name and an unknown tool on the head line and every marked line of the serve terminal\'s block', async () => {
    const lines = approvalBlock({ ...approval('t1'), tool: 'x\u009b2J_tool', workspaceId: 'w-1', workspaceName: hostileName, call: recordedCall }, new Date())
    expect(lines.join('\n')).not.toMatch(control)
    expect(lines[0]).toMatch(/^\d\d:\d\d:\d\d \[approval\] /)
    expect(lines[0]!.endsWith(`[${shownName}] action pending approval: x\\u009b2J_tool`)).toBe(true)
    for (const line of lines.slice(1).filter(line => line !== '')) expect(line.startsWith(`[${shownName}] `)).toBe(true)
    expect(actionPhrase('unknown\u001b[2J')).toBe('unknown\\u001b[2J')
    expect(actionPhrase('shell_exec')).toBe('run command')
    const { terminal, end } = await shownQuestion(questionFor({ approval: approval('t1'), workspaceId: 'w-1', workspaceName: hostileName, node: 'node-1', context: { correlationId: 'c', sessionId: 's', call: recordedCall } }))
    await end()
    // Readline ends the row it cancels with CR LF, its own.
    expect(terminal.shown().replaceAll('\r\n', '\n')).not.toMatch(control)
    expect(terminal.shown()).toContain(`[${shownName}] Your choice: `)
  })

  it('escapes the workspace name on every line of the watch\'s question', () => {
    const shown = describeQuestion({ ...approval('t1'), workspaceName: hostileName, call: recordedCall })
    expect(shown).not.toMatch(control)
    for (const line of shown.split('\n').filter(line => line !== '')) expect(line.startsWith(`[${shownName}] `)).toBe(true)
  })

  it('escapes what was typed where it writes the answer itself, as the output is no terminal', async () => {
    const terminal = silentTerminal()
    const asked = setupCli({ terminal }).requestCli(named(approval('t1', 600_000)))
    await vi.waitFor(() => expect(terminal.shown()).toMatch(/Your choice: $/), { timeout: 3_000 })
    terminal.input.write('x\u009b2J\n')
    expect(await asked).toMatchObject({ status: 'answered', answer: { choice: 'deny' } })
    await vi.waitFor(() => expect(terminal.shown().endsWith('[The site] Your choice: x\\u009b2J [deny]\n')).toBe(true))
    expect(terminal.shown()).not.toContain('\u009b')
  })

  it('writes the answer and its [deny] after the prompt where the output is no terminal, which echoes nothing', async () => {
    const terminal = silentTerminal()
    const asked = setupCli({ terminal }).requestCli(named(approval('t1', 600_000)))
    await vi.waitFor(() => expect(terminal.shown()).toMatch(/Your choice: $/), { timeout: 3_000 })
    terminal.input.write('x\n')
    expect(await asked).toMatchObject({ status: 'answered', answer: { choice: 'deny' } })
    await vi.waitFor(() => expect(terminal.shown()).toMatch(/\[The site\] Your choice: x \[deny\]\n$/))
  })

  it('ends the row with [timeout] by the clock, whatever ended the question', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { terminal, end } = await shownQuestion(named(approval('t1', 60_000)))
    vi.setSystemTime(Date.now() + 61_000)
    await end()
    expect(terminal.shown()).toMatch(/\[The site\] Your choice: \[timeout\]\n$/)
  })

  // Fix brief 1, H3: the requester's timer, set from the clock, can fire a millisecond before the clock reaches the expiry.
  it.each<[number, string]>([[1, '[timeout]'], [200, '[no longer waiting]']])('ends a question %d ms before its expiry with %s', async (early, tag) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const ask = approval('t1', 60_000)
    const { terminal, end } = await shownQuestion(named(ask))
    vi.setSystemTime(Date.parse(ask.expiresAt) - early)
    await end()
    expect(terminal.shown().endsWith(`[The site] Your choice: ${tag}\n`)).toBe(true)
  })

  it('writes the ending back on the prompt row at a terminal, clearing what was half typed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const terminal = keyboardTerminal()
    const stop = new AbortController()
    const asked = createTerminalConsumer({ ...terminal, onInterrupt: () => {} }).prompt(named(approval('t1', 60_000)), { signal: stop.signal }).catch(() => undefined)
    await vi.waitFor(() => expect(terminal.shown()).toMatch(/Your choice: \S*$/), { timeout: 3_000 })
    terminal.input.write('12')
    await vi.waitFor(() => expect(terminal.shown()).toMatch(/12$/))
    vi.setSystemTime(Date.now() + 61_000)
    stop.abort()
    await asked
    expect(terminal.shown()).toMatch(/12\r\n\u001b\[1A\u001b\[25G\u001b\[0J\[timeout\]\n$/)
  })

  // Fix brief 1, H1: the logger writes an event a microtask after it is logged, and the setup face's withdrawal logs in the
  // turn it ends the question, so the writer holds such a line until the ending is on the prompt row.
  it.each(['before', 'after'] as const)('writes a line logged in the turn the question ends below its ending, the ending on the prompt row: logged %s the abort', async (side) => {
    const terminal = keyboardTerminal()
    const writer = createConsoleWriter({ output: terminal.output, dates: false })
    const stop = new AbortController()
    const asked = createTerminalConsumer({ ...terminal, console: writer, onInterrupt: () => {} }).prompt(named(approval('t1', 600_000)), { signal: stop.signal }).catch(() => undefined)
    await vi.waitFor(() => expect(terminal.shown()).toMatch(/Your choice: \S*$/), { timeout: 3_000 })
    const log = () => { void Promise.resolve().then(() => writer.write(['22:22:05 [info] Withdrew a call\'s approvals withdrawn=1'], new Date())) }
    if (side === 'before') log()
    stop.abort()
    if (side === 'after') log()
    await asked
    expect(terminal.shown()).toMatch(/Your choice: \S*\r\n\u001b\[1A\u001b\[25G\u001b\[0J\[no longer waiting\]\n22:22:05 \[info\] Withdrew a call's approvals withdrawn=1\n$/)
  })

  // Fix brief 2, L2: the same turn, but with the prompt not yet drawn, in the half second of quiet after the block.
  describe('a question that ends in the quiet before its prompt', () => {
    async function endedInQuiet(logInTurn: boolean) {
      const terminal = keyboardTerminal()
      const writer = createConsoleWriter({ output: terminal.output, dates: false })
      const stop = new AbortController()
      const asked = createTerminalConsumer({ ...terminal, console: writer, onInterrupt: () => {} }).prompt(named(approval('t1', 600_000)), { signal: stop.signal }).catch(() => undefined)
      await vi.waitFor(() => expect(terminal.shown()).toMatch(/\(n\) deny\n$/), { timeout: 3_000 })
      if (logInTurn) void Promise.resolve().then(() => writer.write(['22:22:05 [info] Withdrew a call\'s approvals withdrawn=1'], new Date()))
      stop.abort()
      await asked
      return terminal.shown()
    }

    it('writes its ending straight below the choices line, and a line logged in the turn it ends below the ending', async () => {
      expect(await endedInQuiet(true)).toMatch(/\(n\) deny\n\[The site\] Your choice: \[no longer waiting\]\n22:22:05 \[info\] Withdrew a call's approvals withdrawn=1\n$/)
    })

    it('holds the lines that follow too where it ended before its block was written', async () => {
      const terminal = keyboardTerminal()
      let finishFlush: (() => void) | undefined
      const base = createConsoleWriter({ output: terminal.output, dates: false, flush: () => new Promise<void>((resolve) => { finishFlush = resolve }) })
      // A line the logger writes in the turn after the block lands, as the question is found ended.
      const writer = { ...base, holding: () => { const quiet = base.holding(); queueMicrotask(() => base.write(['22:22:05 [info] Withdrew a call\'s approvals withdrawn=1'], new Date())); return quiet } }
      const stop = new AbortController()
      const asked = createTerminalConsumer({ ...terminal, console: writer, onInterrupt: () => {} }).prompt(named(approval('t1', 600_000)), { signal: stop.signal }).catch(() => undefined)
      await vi.waitFor(() => expect(finishFlush).toBeDefined())
      stop.abort()
      finishFlush!()
      await asked
      expect(terminal.shown()).toMatch(/\(n\) deny\n\[The site\] Your choice: \[no longer waiting\]\n22:22:05 \[info\] Withdrew a call's approvals withdrawn=1\n$/)
    })

    // Moving the cursor up from here would erase the line logged just above, which is why an ending with no prompt is written plainly.
    it('writes its ending as a plain row, with no cursor control, where no prompt was drawn', async () => {
      const shown = await endedInQuiet(false)
      expect(shown).toMatch(/\(n\) deny\n\[The site\] Your choice: \[no longer waiting\]\n$/)
      expect(shown).not.toContain('\u001b')
    })
  })

  // Under TERM=dumb the row cannot be drawn again in place: what readline echoed stays, and the row is written whole below it.
  describe('where TERM is dumb', () => {
    beforeEach(() => { vi.stubEnv('TERM', 'dumb') })

    it.each<[string, string, string]>([
      ['Enter adds [deny]', '', '[The site] Your choice: \r\n[The site] Your choice: [deny]\n'],
      ['an unknown key adds [deny]', 'x', '[The site] Your choice: x\r\n[The site] Your choice: x [deny]\n'],
    ])('writes the answer row whole below the echoed one, with no escape: %s', async (_, key, row) => {
      const terminal = keyboardTerminal()
      const asked = setupCli({ terminal }).requestCli(named(approval('t1', 600_000)))
      await vi.waitFor(() => expect(terminal.shown()).toMatch(/Your choice: \S*$/), { timeout: 3_000 })
      terminal.input.write(`${key}\r`)
      expect(await asked).toMatchObject({ status: 'answered', answer: { choice: 'deny' } })
      await vi.waitFor(() => expect(terminal.shown().endsWith(row)).toBe(true))
      expect(terminal.shown()).not.toContain('\u001b')
    })

    it('leaves the echoed row as it is for an answer that is no denial, and sends no escape', async () => {
      const terminal = keyboardTerminal()
      const asked = setupCli({ terminal }).requestCli(named(approval('t1', 600_000)))
      await vi.waitFor(() => expect(terminal.shown()).toMatch(/Your choice: \S*$/), { timeout: 3_000 })
      terminal.input.write('1\r')
      expect(await asked).toMatchObject({ status: 'answered', answer: { choice: 'once' } })
      await vi.waitFor(() => expect(terminal.shown()).toMatch(/\[The site\] Your choice: 1\r\n$/))
      expect(terminal.shown()).not.toContain('\u001b')
    })

    it('escapes what was typed where it writes the denied row again', async () => {
      const terminal = keyboardTerminal()
      const asked = setupCli({ terminal }).requestCli(named(approval('t1', 600_000)))
      await vi.waitFor(() => expect(terminal.shown()).toMatch(/Your choice: \S*$/), { timeout: 3_000 })
      terminal.input.write('x\u009b2J\r')
      expect(await asked).toMatchObject({ status: 'answered', answer: { choice: 'deny' } })
      await vi.waitFor(() => expect(terminal.shown().endsWith('[The site] Your choice: x\\u009b2J [deny]\n')).toBe(true))
      expect(terminal.shown().slice(terminal.shown().lastIndexOf('\n', terminal.shown().length - 2))).not.toContain('\u009b')
    })

    it('writes the ending on a row of its own below the half-typed text, with no escape', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const terminal = keyboardTerminal()
      const stop = new AbortController()
      const asked = createTerminalConsumer({ ...terminal, onInterrupt: () => {} }).prompt(named(approval('t1', 60_000)), { signal: stop.signal }).catch(() => undefined)
      await vi.waitFor(() => expect(terminal.shown()).toMatch(/Your choice: \S*$/), { timeout: 3_000 })
      terminal.input.write('12')
      await vi.waitFor(() => expect(terminal.shown()).toMatch(/12$/))
      vi.setSystemTime(Date.now() + 61_000)
      stop.abort()
      await asked
      expect(terminal.shown()).toMatch(/Your choice: 12\r\n\[The site\] Your choice: \[timeout\]\n$/)
      expect(terminal.shown()).not.toContain('\u001b')
    })

    it.each(['before', 'after'] as const)('writes a line logged in the turn the question ends below its ending, with no escape: logged %s the abort', async (side) => {
      const terminal = keyboardTerminal()
      const writer = createConsoleWriter({ output: terminal.output, dates: false })
      const stop = new AbortController()
      const asked = createTerminalConsumer({ ...terminal, console: writer, onInterrupt: () => {} }).prompt(named(approval('t1', 600_000)), { signal: stop.signal }).catch(() => undefined)
      await vi.waitFor(() => expect(terminal.shown()).toMatch(/Your choice: \S*$/), { timeout: 3_000 })
      const log = () => { void Promise.resolve().then(() => writer.write(['22:22:05 [info] Withdrew a call\'s approvals withdrawn=1'], new Date())) }
      if (side === 'before') log()
      stop.abort()
      if (side === 'after') log()
      await asked
      expect(terminal.shown()).toMatch(/Your choice: \r\n\[The site\] Your choice: \[no longer waiting\]\n22:22:05 \[info\] Withdrew a call's approvals withdrawn=1\n$/)
      expect(terminal.shown()).not.toContain('\u001b')
    })

    it('writes a plain row as before where the output is no terminal', async () => {
      const terminal = silentTerminal()
      const asked = setupCli({ terminal }).requestCli(named(approval('t1', 600_000)))
      await vi.waitFor(() => expect(terminal.shown()).toMatch(/Your choice: $/), { timeout: 3_000 })
      terminal.input.write('x\n')
      expect(await asked).toMatchObject({ status: 'answered', answer: { choice: 'deny' } })
      await vi.waitFor(() => expect(terminal.shown()).toMatch(/\[The site\] Your choice: x \[deny\]\n$/))
      expect(terminal.shown().match(/Your choice: /g)).toHaveLength(1)
    })
  })

  // H1: a workspace name in wide characters takes two columns a character, so the row is placed by readline's display width.
  const wide = (ask: ApprovalRequest) => questionFor({ approval: ask, workspaceId: 'w-2', workspaceName: '\u8bbe\u8ba1\u7a3f', node: 'node-1', context: { correlationId: 'c', sessionId: 's', call: recordedCall } })

  it('writes an ending at the prompt\'s display width where the workspace name is in wide characters', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const terminal = keyboardTerminal()
    const stop = new AbortController()
    const asked = createTerminalConsumer({ ...terminal, onInterrupt: () => {} }).prompt(wide(approval('t1', 60_000)), { signal: stop.signal }).catch(() => undefined)
    await vi.waitFor(() => expect(terminal.shown()).toMatch(/Your choice: \S*$/), { timeout: 3_000 })
    vi.setSystemTime(Date.now() + 61_000)
    stop.abort()
    await asked
    // `[\u8bbe\u8ba1\u7a3f] Your choice: ` is 19 code units and 22 columns.
    expect(terminal.shown()).toMatch(/\r\n\u001b\[1A\u001b\[23G\u001b\[0J\[timeout\]\n$/)
  })

  it('draws the prompt row again with an unknown key and [deny] where the workspace name is in wide characters', async () => {
    const terminal = keyboardTerminal()
    const asked = setupCli({ terminal }).requestCli(wide(approval('t1', 600_000)))
    await vi.waitFor(() => expect(terminal.shown()).toMatch(/Your choice: \S*$/), { timeout: 3_000 })
    terminal.input.write('x\r')
    expect(await asked).toMatchObject({ status: 'answered', answer: { choice: 'deny' } })
    await vi.waitFor(() => expect(terminal.shown()).toMatch(/x\r\n\u001b\[1A\u001b\[1G\u001b\[0J\[\u8bbe\u8ba1\u7a3f\] Your choice: x \[deny\]\n$/))
  })

  it('puts [deny] on the prompt row where a paste carries Enter twice', async () => {
    const terminal = keyboardTerminal()
    const asked = setupCli({ terminal }).requestCli(named(approval('t1', 600_000)))
    await vi.waitFor(() => expect(terminal.shown()).toMatch(/Your choice: \S*$/), { timeout: 3_000 })
    terminal.input.write('x\r\r')
    expect(await asked).toMatchObject({ status: 'answered', answer: { choice: 'deny' } })
    await vi.waitFor(() => expect(terminal.shown()).toMatch(/x\r\n\r\n\u001b\[2A\u001b\[1G\u001b\[0J\[The site\] Your choice: x \[deny\]\n$/))
  })

  it('ends the row with [no longer waiting] where it ends before its expiry: answered elsewhere, or the call withdrawn', async () => {
    const { terminal, end } = await shownQuestion(named(approval('t1', 600_000)))
    await end()
    expect(terminal.shown()).toMatch(/\[The site\] Your choice: \[no longer waiting\]\n$/)
  })

  it('ends the row with [stopped] where the process stops with the question open', async () => {
    const terminal = silentTerminal()
    const cli = setupCli({ terminal })
    const asked = cli.requestCli(named(approval('t1', 600_000)))
    await vi.waitFor(() => expect(terminal.shown()).toMatch(/Your choice: $/), { timeout: 3_000 })
    await cli.close()
    expect(await asked).toMatchObject({ status: 'unavailable', reason: 'closed' })
    await vi.waitFor(() => expect(terminal.shown()).toMatch(/\[The site\] Your choice: \[stopped\]\n$/))
  })

  // The 400 ms poll withdraws a question whose ask left the queue, and the queue drops an expired ask, so at its expiry a
  // question often ends cancelled before the requester's own timer fires: the clock decides, not the outcome.
  it('shows [timeout] where the poll withdraws an expired question before the requester\'s own timer', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const terminal = silentTerminal()
    const queue = stubQueue([approval('t1', 60_000)])
    const call = waitingService({ registry: queue.registry, graceMs: 200, requestCli: setupCli({ terminal }).requestCli })()
    await vi.waitFor(() => expect(terminal.shown()).toMatch(/Your choice: $/), { timeout: 3_000 })
    // Past the expiry on the clock, with the requester's timer still a minute out.
    vi.setSystemTime(Date.now() + 61_000)
    await vi.waitFor(() => expect(terminal.shown()).toContain('Your choice: [timeout]\n'), { timeout: 3_000 })
    expect(await call).toMatchObject({ settled: false })
  })
})
