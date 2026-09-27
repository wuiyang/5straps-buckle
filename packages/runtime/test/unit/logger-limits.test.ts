import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { createLogger, type LogEvent, type LogSink } from '../../src/index.js'

function memorySink(): LogSink & { events: LogEvent[] } {
  const events: LogEvent[] = []
  return { name: 'memory', events, write: (event) => { events.push(event) } }
}

async function logOnce(fields: Record<string, unknown>, options: { omitKeys?: string[]; message?: string } = {}): Promise<LogEvent> {
  const sink = memorySink()
  const root = createLogger({ component: 'test', sinks: [sink], omitKeys: options.omitKeys })
  root.logger.info(options.message ?? 'event', fields)
  await root.flush()
  return sink.events[0]!
}

describe('logger shapes and limits (review M4)', () => {
  it('omits byte views with their size', async () => {
    const event = await logOnce({ chunk: Buffer.alloc(3_000), view: new Uint8Array(12), raw: new ArrayBuffer(7) })
    expect(event.fields).toEqual({ chunk: '[omitted 3000 bytes]', view: '[omitted 12 bytes]', raw: '[omitted 7 bytes]' })
  })

  it('caps keys per object and bytes per event', async () => {
    const wide = Object.fromEntries(Array.from({ length: 20_000 }, (_, index) => [`k${index}`, index]))
    const event = await logOnce({ wide })
    expect(Object.keys(event.fields!.wide as object).length).toBeLessThanOrEqual(101)
    expect(JSON.stringify(event).length).toBeLessThan(70_000)

    const heavy = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`k${index}`, 'x'.repeat(8_000)]))
    const capped = await logOnce({ heavy })
    expect(JSON.stringify(capped).length).toBeLessThan(70_000)
    expect(capped.fields).toEqual({ '[truncated]': expect.stringContaining('exceeded') })
  })

  it('redacts secret-named query parameters and URL passwords inside strings', async () => {
    const event = await logOnce({ url: 'https://api.example.com/v1?token=abc123&page=2', note: 'fetch https://user:hunter2@example.com/x?api_key=zzz9 failed' }, { message: 'GET https://example.com/cb?code=1&access_token=qqq7' })
    const serialized = JSON.stringify(event)
    for (const secret of ['abc123', 'hunter2', 'zzz9', 'qqq7']) expect(serialized).not.toContain(secret)
    expect(event.fields!.url).toContain('page=2')
  })

  it('redacts header tuple arrays and Headers objects by name', async () => {
    const event = await logOnce({ headers: [['x-api-key', 'k1'], ['accept', 'json']], fetched: new Headers({ authorization: 'Bearer zz', accept: 'json' }) })
    expect(event.fields).toEqual({ headers: [['x-api-key', '[redacted]'], ['accept', 'json']], fetched: { authorization: '[redacted]', accept: 'json' } })
  })

  it('omits keys named in omitKeys', async () => {
    const event = await logOnce({ input: 'user prompt text', text: 'model reply' }, { omitKeys: ['input', 'text'] })
    expect(event.fields).toEqual({ input: '[omitted 16 bytes]', text: '[omitted 11 bytes]' })
  })
})

describe('logger keeps useful data (review M5)', () => {
  it('keeps token counts, file paths, stack paths and git SHAs', async () => {
    const path = '/home/user/projects/buckle/packages/runtime/src/logger/sanitize.ts'
    const sha = '6ec41b3a1f2e4d5c6b7a8f9e0d1c2b3a4f5e6d7c'
    const event = await logOnce({ inputTokens: 1_200, outputTokens: 30, file: path, commit: sha }, { message: `at ${path}:12:3 in ${sha}` })
    expect(event.fields).toEqual({ inputTokens: 1_200, outputTokens: 30, file: path, commit: sha })
    expect(event.message).toBe(`at ${path}:12:3 in ${sha}`)
  })

  it('still redacts secret-named keys by word', async () => {
    const sha = '6ec41b3a1f2e4d5c6b7a8f9e0d1c2b3a4f5e6d7c'
    const event = await logOnce({ accessToken: 'a', auth: 'b', apiKey: 'c', client_secret: 'd', webhookSecret: sha, sessionToken: 'e' })
    expect(Object.values(event.fields!)).toEqual(Array(6).fill('[redacted]'))
  })
})

describe('secret keys and opaque values (logger-fixes-1, logger-fixes-2)', () => {
  it('redacts plural and run-together secret key names while token counts stay numbers', async () => {
    const secretKeys = ['tokens', 'secrets', 'cookies', 'passwords', 'apiKeys', 'api_keys', 'accessTokens', 'refreshTokens', 'accesstoken', 'authtoken', 'csrftoken', 'clientsecret', 'secretkey', 'newpassword', 'PGPASSWORD', 'credentials']
    const countKeys = ['inputTokens', 'outputTokens', 'input_tokens', 'maxTokens', 'max_tokens', 'totalTokenCount', 'tokenCount', 'token_count', 'cachedInputTokens']
    const event = await logOnce({ ...Object.fromEntries(secretKeys.map(key => [key, 'short-opaque-19char'])), ...Object.fromEntries(countKeys.map((key, index) => [key, index])) })
    expect(Object.fromEntries(secretKeys.map(key => [key, event.fields![key]]))).toEqual(Object.fromEntries(secretKeys.map(key => [key, '[redacted]'])))
    expect(Object.fromEntries(countKeys.map(key => [key, event.fields![key]]))).toEqual(Object.fromEntries(countKeys.map((key, index) => [key, index])))
  })

  it('redacts base64 and AWS-style secrets that contain a slash, in fields and messages', async () => {
    const aws = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
    const base64 = 'K7gNU3sdo+OL0wNhqoVWhr3g6s1xYv72ol/pe/Unols='
    const leadingSlash = '/7gNU3sdo+OL0wNhqoVWhr3g6s1xYv72ol/pe/Unols='
    const accountKey = `${'Ab3/'.repeat(21)}Zz==`
    const event = await logOnce({ note: `k=${aws}`, cmd: `aws configure set aws_secret_access_key ${aws}`, b64: `k=${base64}`, slash: leadingSlash, azure: `DefaultEndpointsProtocol=https;AccountKey=${accountKey};EndpointSuffix=core.windows.net` }, { message: `retrying with ${base64}` })
    const serialized = JSON.stringify(event)
    for (const secret of [aws, base64, leadingSlash, accountKey, 'K7MDENG', 'pe/Unols']) expect(serialized).not.toContain(secret)
  })

  it('keeps absolute and relative paths and stack frames readable', async () => {
    const relative = 'packages/runtime/test/fixture/layers/common/server/routes/v1/database/baked'
    const frame = 'at runRequestInScope (file:///home/user/projects/buckle/packages/runtime/src/nitro/guards.ts:125:29)'
    const event = await logOnce({ relative, frame, dir: '/home/user/.5straps/buckle/workspaces/2f9c1d/history' })
    expect(event.fields).toEqual({ relative, frame, dir: '/home/user/.5straps/buckle/workspaces/2f9c1d/history' })
  })
})

describe('event size and hex runs (logger-fixes-4, logger-fixes-5)', () => {
  function bigError(index: number, depth = 0): Error {
    const error = new Error(`failure ${index} ${'m'.repeat(9_000)}`, depth < 2 ? { cause: bigError(index, depth + 1) } : undefined)
    error.stack = `${error.message}\n${'    at frame (/srv/app/file.js:1:1)\n'.repeat(400)}`
    return error
  }

  it('caps the whole event, error included, at maxEventBytes', async () => {
    const aggregate = new AggregateError(Array.from({ length: 50 }, (_, index) => bigError(index)), 'batch failed')
    const nested = new AggregateError(Array.from({ length: 50 }, () => new AggregateError(Array.from({ length: 50 }, (_, index) => bigError(index)), 'inner')), 'outer')
    for (const error of [aggregate, nested]) {
      const event = await logOnce({ error, requestId: 'r-1' })
      expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThanOrEqual(65_536 + 1_024)
      expect(event.error).toMatchObject({ name: 'AggregateError' })
      expect(event.fields).toMatchObject({ requestId: 'r-1' })
    }
  })

  it('redacts a 40-hex credential in free text while git SHAs stay readable', async () => {
    const hex = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3'
    const event = await logOnce({ note: `retrying with client secret ${hex}`, pat: `pat ${hex}`, url: `https://api.example.com/cb?client=x&s=${hex}`, upper: hex.toUpperCase(), commit: hex, log: `HEAD is now at ${hex}` }, { message: `token ${hex} rejected` })
    expect(event.message).toBe('token [redacted] rejected')
    expect(event.fields).toMatchObject({ note: 'retrying with client secret [redacted]', pat: 'pat [redacted]', upper: '[redacted]', commit: hex, log: `HEAD is now at ${hex}` })
    expect(String(event.fields!.url)).not.toContain(hex)
  })
})

describe('sink recursion across awaits (review M6)', () => {
  it('sends a log line from inside an async sink to the fallback only', async () => {
    const fallback: string[] = []
    let writes = 0
    let root: ReturnType<typeof createLogger> | undefined
    const sink: LogSink = { name: 'async', async write() {
      writes += 1
      await delay(1)
      root!.logger.info('from inside the sink')
    } }
    root = createLogger({ component: 'svc', sinks: [sink], fallback: line => fallback.push(line) })
    root.logger.info('one')
    await delay(20)
    await root.flush()
    expect(writes).toBe(1)
    expect(fallback.filter(line => line.includes('from inside the sink'))).toHaveLength(1)
  })
})

describe('close and drops (review L3)', () => {
  it('drops and counts events logged once close has started', async () => {
    const sink = memorySink()
    const root = createLogger({ component: 'svc', sinks: [sink] })
    root.logger.info('before')
    const closing = root.close()
    root.logger.info('during close')
    await closing
    root.logger.info('after close')
    expect(sink.events.map(event => event.message)).toEqual(['before'])
    expect(root.stats().dropped).toBe(2)
  })

  it('emits one warning event when drops start', async () => {
    const sink = memorySink()
    const root = createLogger({ component: 'svc', sinks: [sink], queueLimit: 5 })
    for (let index = 0; index < 8; index += 1) root.logger.info(`event ${index}`)
    await root.flush()
    expect(sink.events.filter(event => event.level === 'warn')).toEqual([expect.objectContaining({ message: 'log events dropped: queue full' })])
    expect(root.stats().dropped).toBe(3)
  })
})
