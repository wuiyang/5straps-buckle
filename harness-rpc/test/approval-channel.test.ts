import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ApprovalDecision, ApprovalRequest } from '@5straps/protocol'
import { describe, expect, it, vi } from 'vitest'
import { createCliApprovalChannel } from '../src/adapters/approval/cli-approval-channel.js'
import { createWaitingApprovalChannel } from '../src/adapters/approval/waiting-approval-channel.js'
import { createSerialQueue } from '../src/domain/serial-queue.js'
import type { ApprovalChannel } from '../src/ports/approval-channel.js'
import { createFileGrantStore } from '../src/adapters/grant-store/file-grant-store.js'
import { createApprovalRegistry, type ApprovalRegistry } from '../src/services/approval-registry.js'

function request(token: string, expiresInMs = 60_000): ApprovalRequest {
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

/** A terminal nobody answers: the streams are open, and no keystroke ever arrives. */
function silentTerminal() {
  const input = new PassThrough()
  const output = new PassThrough()
  let shown = ''
  output.on('data', (chunk: Buffer) => { shown += chunk.toString('utf8') })
  return { input, output, shown: () => shown }
}

/** Only `pending` is consulted by the waiting channel; the rest of the registry is not its concern. */
function registry(pending: () => ApprovalRequest[]): ApprovalRegistry {
  return { pending } as unknown as ApprovalRegistry
}

describe('the grace period before a gated call gives up', () => {
  it('returns as soon as another route resolves the approval', async () => {
    let resolved = false
    setTimeout(() => { resolved = true }, 50)

    const channel = createWaitingApprovalChannel({
      approvals: registry(() => resolved ? [] : [request('t1')]),
      timeoutMs: 5_000,
    })

    const started = Date.now()
    expect(await channel.request([request('t1')])).toEqual([])
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('gives up once the grace period passes, so a call is not held forever', async () => {
    const channel = createWaitingApprovalChannel({
      approvals: registry(() => [request('t1')]),
      timeoutMs: 600,
    })

    expect(await channel.request([request('t1')])).toBeNull()
  })

  it('refuses at once when the grace period is turned off', async () => {
    const pending = vi.fn(() => [request('t1')])
    const channel = createWaitingApprovalChannel({ approvals: registry(pending), timeoutMs: 0 })

    expect(await channel.request([request('t1')])).toBeNull()
    expect(pending).not.toHaveBeenCalled()
  })

  it('waits for every token, not just the first one answered', async () => {
    let answered = 0
    const channel = createWaitingApprovalChannel({
      approvals: registry(() => [request('t1'), request('t2')].slice(answered)),
      timeoutMs: 3_000,
    })

    setTimeout(() => { answered = 1 }, 50)
    setTimeout(() => { answered = 2 }, 300)

    expect(await channel.request([request('t1'), request('t2')])).toEqual([])
  })

  it('announces the request before waiting, so someone can be reached in time', async () => {
    const notify = vi.fn(async () => undefined)
    const channel = createWaitingApprovalChannel({
      approvals: registry(() => []),
      timeoutMs: 1_000,
      notify,
    })

    await channel.request([request('t1')])
    expect(notify).toHaveBeenCalledOnce()
  })

  it('still waits when announcing fails, rather than failing the call itself', async () => {
    const channel = createWaitingApprovalChannel({
      approvals: registry(() => []),
      timeoutMs: 1_000,
      notify: async () => { throw new Error('telegram is down') },
    })

    expect(await channel.request([request('t1')])).toEqual([])
  })

  it('takes a terminal answer when one arrives first', async () => {
    const decision: ApprovalDecision = { token: 't1', approved: true, scope: 'session' }
    const prompt: ApprovalChannel = { id: 'stub', request: async () => [decision] }

    const channel = createWaitingApprovalChannel({
      approvals: registry(() => [request('t1')]),
      timeoutMs: 5_000,
      prompt,
    })

    expect(await channel.request([request('t1')])).toEqual([decision])
  })

  it('tells the terminal to let go once another route has answered', async () => {
    let aborted = false
    const prompt: ApprovalChannel = {
      id: 'stub',
      request: (_requests, signal) => new Promise(resolve => {
        signal?.addEventListener('abort', () => {
          aborted = true
          resolve(null)
        })
      }),
    }

    const channel = createWaitingApprovalChannel({
      approvals: registry(() => []),
      timeoutMs: 2_000,
      prompt,
    })

    await channel.request([request('t1')])
    expect(aborted).toBe(true)
  })
})

/** A prompt that answers when told to, and records whether it was told to let go. */
function heldPrompt() {
  let answer: (decisions: ApprovalDecision[]) => void = () => undefined
  let aborted = false
  const prompt: ApprovalChannel = {
    id: 'held',
    request: (_requests, signal) => new Promise(resolve => {
      answer = resolve
      signal?.addEventListener('abort', () => { aborted = true; resolve(null) })
    }),
  }
  return { prompt, answer: (decisions: ApprovalDecision[]) => answer(decisions), aborted: () => aborted }
}

describe('the terminal question after the grace period', () => {
  it('stays open past the grace deadline while the call reports back', async () => {
    const held = heldPrompt()
    const channel = createWaitingApprovalChannel({ approvals: registry(() => [request('t1')]), timeoutMs: 200, prompt: held.prompt })

    expect(await channel.request([request('t1')])).toBeNull()
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(held.aborted()).toBe(false)
  })

  it('records an answer given after the grace period, resolving the pending approval', async () => {
    const approvals = createApprovalRegistry(createFileGrantStore({ filePath: join(tmpdir(), 'grace-grants.json'), workspace: '/workspace' }), join(tmpdir(), 'grace-approvals.json'))
    const [issued] = approvals.issue({ tool: 'fs_read', sessionId: 'reader', asks: [{ kind: 'ask', rule: 'read_scope', subject: '/outside', reason: 'outside', offeredScopes: ['once', 'session', 'always'] }] })
    const held = heldPrompt()
    const channel = createWaitingApprovalChannel({ approvals, timeoutMs: 200, prompt: held.prompt })

    expect(await channel.request([issued!])).toBeNull()
    expect(approvals.pending().map(entry => entry.token)).toEqual([issued!.token])
    held.answer([{ token: issued!.token, approved: true, scope: 'session' }])
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(approvals.pending()).toEqual([])
    expect(approvals.resolve({ token: issued!.token, approved: true, scope: 'session' })).toEqual({ ok: true })
  })

  it('closes once the request expires', async () => {
    const expiring = request('t1', 700)
    const held = heldPrompt()
    const channel = createWaitingApprovalChannel({
      approvals: registry(() => [expiring].filter(entry => Date.parse(entry.expiresAt) > Date.now())),
      timeoutMs: 200,
      prompt: held.prompt,
    })

    expect(await channel.request([expiring])).toBeNull()
    expect(held.aborted()).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 1_000))
    expect(held.aborted()).toBe(true)
  })

  it('closes once another route answers after the grace period', async () => {
    let answered = false
    const held = heldPrompt()
    const channel = createWaitingApprovalChannel({ approvals: registry(() => answered ? [] : [request('t1')]), timeoutMs: 200, prompt: held.prompt })

    expect(await channel.request([request('t1')])).toBeNull()
    answered = true
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(held.aborted()).toBe(true)
  })
})

describe('the terminal prompt queue', () => {
  it('answers nothing without a terminal, rather than blocking on a pipe', async () => {
    const wasTty = process.stdin.isTTY
    process.stdin.isTTY = false
    try {
      expect(await createCliApprovalChannel().request([request('t1')])).toBeNull()
    } finally {
      process.stdin.isTTY = wasTty
    }
  })

  it('gives up on a question once its own request expires, rather than holding the terminal', async () => {
    const wasTty = process.stdin.isTTY
    process.stdin.isTTY = true
    const terminal = silentTerminal()
    try {
      const channel = createCliApprovalChannel(terminal)

      const asked = channel.request([request('t1', 300)])
      expect(await asked).toBeNull()
      expect(terminal.shown()).toContain('expires in')
    } finally {
      process.stdin.isTTY = wasTty
    }
  })

  it('asks the next queued question after one expires, so a live request is still answerable', async () => {
    const wasTty = process.stdin.isTTY
    process.stdin.isTTY = true
    const terminal = silentTerminal()
    try {
      const channel = createCliApprovalChannel(terminal)

      const first = channel.request([request('expiring', 300)])
      const second = channel.request([request('live', 600)])
      expect(await first).toBeNull()
      expect(await second).toBeNull()
      // Both questions reached the terminal, which is what a held terminal would have stopped.
      expect(terminal.shown()).toContain('outside the sandbox')
      expect(terminal.shown().match(/needs approval/g)).toHaveLength(2)
    } finally {
      process.stdin.isTTY = wasTty
    }
  })

  it('does not ask about a request whose expiry passed while it queued', async () => {
    const wasTty = process.stdin.isTTY
    process.stdin.isTTY = true
    const terminal = silentTerminal()
    try {
      expect(await createCliApprovalChannel(terminal).request([request('stale', -1_000)])).toBeNull()
      expect(terminal.shown()).toBe('')
    } finally {
      process.stdin.isTTY = wasTty
    }
  })

  it('declines a queued question that was cancelled while it waited its turn', async () => {
    const wasTty = process.stdin.isTTY
    process.stdin.isTTY = true
    try {
      const channel = createCliApprovalChannel()
      const controller = new AbortController()
      controller.abort()

      // Already aborted, so it must return without ever touching stdin.
      expect(await channel.request([request('t1')], controller.signal)).toBeNull()
    } finally {
      process.stdin.isTTY = wasTty
    }
  })
})

describe('the queue that keeps one question on screen at a time', () => {
  it('never runs two tasks at once, which is what stops an answer landing on the wrong request', async () => {
    const queue = createSerialQueue()
    let running = 0
    let overlapped = false

    const task = () => queue(async () => {
      running += 1
      if (running > 1) overlapped = true
      await new Promise(resolve => setTimeout(resolve, 5))
      running -= 1
    })

    await Promise.all([task(), task(), task(), task()])
    expect(overlapped).toBe(false)
  })

  it('keeps submission order, so the person answers questions as they arrived', async () => {
    const queue = createSerialQueue()
    const order: number[] = []

    await Promise.all([1, 2, 3].map(n => queue(async () => {
      await new Promise(resolve => setTimeout(resolve, 10 - n))
      order.push(n)
    })))

    expect(order).toEqual([1, 2, 3])
  })

  it('keeps serving the queue after a task throws', async () => {
    const queue = createSerialQueue()
    await expect(queue(async () => { throw new Error('declined') })).rejects.toThrow('declined')
    await expect(queue(async () => 'next one still runs')).resolves.toBe('next one still runs')
  })
})
