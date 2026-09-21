import type { ActionReport } from '@5straps/protocol'
import { ACTION_REPORT_BATCH_MAX } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebhookReporter } from '../src/adapters/report/webhook-reporter.js'

afterEach(() => { vi.unstubAllGlobals() })

function entry(requestId: string): ActionReport {
  return {
    workspace: '/work', workspaceId: 'default',
    at: new Date().toISOString(), requestId, sessionId: 'chat-1', tool: 'fs_list',
    outcome: 'ok', durationMs: 1, effects: ['read_path'], args: { path: '.' },
    rule: null, subject: '', reason: '', asked: [], approvedBy: [], detail: null,
  }
}

/** Captures each post, answering with the status the test asked for. */
function endpoint(statuses: number[] = []) {
  const posts: Array<{ event: string; serverId: string; reports: ActionReport[] }> = []
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    posts.push(JSON.parse(String(init.body)) as { event: string; serverId: string; reports: ActionReport[] })
    const status = statuses.shift() ?? 201
    if (status === 0) throw new Error('connect ECONNREFUSED')
    return new Response(null, { status })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { posts, fetchMock }
}

describe('the batched action-log reporter', () => {
  it('holds entries back until a flush, then posts them as one batch in order', async () => {
    const { posts } = endpoint()
    const reporter = createWebhookReporter({ url: 'http://rings.test/report', token: 'secret', serverId: 'node-1', flushIntervalMs: 60_000 })

    reporter.record(entry('req-1'))
    reporter.record(entry('req-2'))
    expect(posts).toHaveLength(0)

    await reporter.flush()
    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({ event: 'action_log', serverId: 'node-1' })
    expect(posts[0]?.reports.map(report => report.requestId)).toEqual(['req-1', 'req-2'])
  })

  it('posts on its own once a batch is full, without waiting for the interval', async () => {
    const { posts } = endpoint()
    const reporter = createWebhookReporter({ url: 'http://rings.test/report', token: 'secret', serverId: 'node-1', flushIntervalMs: 60_000 })

    for (let index = 0; index < ACTION_REPORT_BATCH_MAX; index++) reporter.record(entry(`req-${index}`))
    await reporter.flush()

    expect(posts).toHaveLength(1)
    expect(posts[0]?.reports).toHaveLength(ACTION_REPORT_BATCH_MAX)
  })

  it('splits more than one batch worth of entries across posts', async () => {
    const { posts } = endpoint()
    const reporter = createWebhookReporter({ url: 'http://rings.test/report', token: 'secret', serverId: 'node-1', flushIntervalMs: 60_000 })

    for (let index = 0; index < ACTION_REPORT_BATCH_MAX + 3; index++) reporter.record(entry(`req-${index}`))
    await reporter.flush()

    expect(posts.map(post => post.reports.length)).toEqual([ACTION_REPORT_BATCH_MAX, 3])
  })

  it('retries an unreachable endpoint up to its cap, then drops the batch rather than growing', async () => {
    const { posts, fetchMock } = endpoint([0, 0, 0])
    const reporter = createWebhookReporter({ url: 'http://rings.test/report', token: 'secret', serverId: 'node-1', flushIntervalMs: 60_000, retryDelayMs: 1 })

    reporter.record(entry('req-1'))
    await reporter.flush()
    expect(fetchMock).toHaveBeenCalledTimes(3)

    // The dropped batch is gone from memory; the next flush carries only what came after it.
    posts.length = 0
    reporter.record(entry('req-2'))
    await reporter.flush()
    expect(posts).toHaveLength(1)
    expect(posts[0]?.reports.map(report => report.requestId)).toEqual(['req-2'])
  })

  it('does not retry a payload the endpoint refused outright', async () => {
    const { fetchMock } = endpoint([400])
    const reporter = createWebhookReporter({ url: 'http://rings.test/report', token: 'secret', serverId: 'node-1', flushIntervalMs: 60_000, retryDelayMs: 1 })

    reporter.record(entry('req-1'))
    await reporter.flush()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('drops the oldest entries rather than queueing without bound', async () => {
    const { posts } = endpoint()
    const reporter = createWebhookReporter({ url: 'http://rings.test/report', token: 'secret', serverId: 'node-1', flushIntervalMs: 60_000 })

    for (let index = 0; index < 600; index++) reporter.record(entry(`req-${index}`))
    await reporter.flush()

    const delivered = posts.flatMap(post => post.reports)
    expect(delivered.length).toBeLessThanOrEqual(500)
    expect(delivered.at(-1)?.requestId).toBe('req-599')
  })
})
