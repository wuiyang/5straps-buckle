import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { CliRequest, RequestCli } from '@5straps/runtime'
import type { ApprovalDecision, ApprovalRequest } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupCli } from '../cli/setup.js'
import { remainingMs } from '../common/domain/approval-deadline.js'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { createApprovalRegistry, type ApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import { createApprovalService, questionFor } from '../common/services/approvals/approval-service.js'
import { describeApprovalRequest, printable } from '../common/domain/approval-instruction.js'
import { describeQuestion } from '../cli/terminal-consumer.js'
import type { ApprovalHold } from '../common/services/approvals/interaction.js'
import { SPAWN_TEST_TIMEOUT_MS } from './spawn-timeout.js'

afterEach(() => { vi.useRealTimers() })

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

/** The question the approval service puts to the terminal for one request. */
function question(token: string, expiresInMs = 60_000): CliRequest {
  return questionFor({ approval: approval(token, expiresInMs), workspaceId: 'default', context: { correlationId: `c-${token}`, sessionId: 's' } })
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
  }
  return { registry: registry as unknown as ApprovalRegistry, pending: registry.pending, resolved, answerElsewhere: (token: string) => { pending = pending.filter(request => request.token !== token) } }
}

const nobody: RequestCli = async request => ({ status: 'unavailable', requestId: request.id, reason: 'no_consumer' })

function waitingService(input: { registry: ApprovalRegistry; graceMs: number | null; requestCli?: RequestCli; hold?: ApprovalHold; announce?: (requests: ApprovalRequest[]) => Promise<void> }) {
  const service = createApprovalService({ registry: input.registry, workspaceId: 'default', graceMs: input.graceMs, interaction: async () => ({ requestCli: input.requestCli ?? nobody, hold: input.hold ?? 'grace' }), ...(input.announce ? { announce: input.announce } : {}) })
  return (tokens = 1) => service.request({ sessionId: 's', requestId: 'r', tool: 'fs_read', asks: Array.from({ length: tokens }, () => ({ kind: 'ask' as const, rule: 'read_scope' as const, subject: '/shots', reason: 'outside the sandbox', offeredScopes: ['once' as const, 'session' as const, 'always' as const] })) })
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

  it('refuses at once when the grace period is turned off, asking nobody', async () => {
    const queue = stubQueue([approval('t1')])
    const requestCli = vi.fn(nobody)
    expect(await waitingService({ registry: queue.registry, graceMs: 0, requestCli })()).toMatchObject({ settled: false })
    expect(queue.pending).not.toHaveBeenCalled()
    expect(requestCli).not.toHaveBeenCalled()
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
    expect(await registry.resolve({ token: issued!.token, approved: true, scope: 'session' })).toEqual({ ok: true, repeated: true })
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
  const prompts = (terminal: ReturnType<typeof keyboardTerminal>) => terminal.shown().match(/n\) deny > /g)?.length ?? 0
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

/** `node-pty` is an optional native dependency, so the real-terminal check runs only where it loads. */
const nativeTerminal = await import('node-pty').then(() => true, () => false)

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
    // Only the first question was ever shown; the queued ones were dropped, not asked in turn.
    expect(terminal.shown().match(/needs approval/g)).toHaveLength(1)
    // The readline is closed: it no longer listens for key presses on the terminal.
    expect(terminal.input.listenerCount('keypress')).toBe(0)
    // A request arriving after Ctrl-C is not asked while the process stops.
    expect(await cli.requestCli(question('late', 600_000))).toMatchObject({ status: 'unavailable', reason: 'no_consumer' })
    expect(onInterrupt).toHaveBeenCalledTimes(1)
  })

  it.runIf(process.platform === 'linux' && nativeTerminal)('stops the process on the first Ctrl-C in a real terminal, with questions open and queued', async () => {
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
