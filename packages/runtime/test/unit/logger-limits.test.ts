import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { createLogger, createOperationScope, runInScope, type LogEvent, type LogSink } from '../../src/index.js'

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

  it('emits one warning event when drops start and one with the count once the queue drains', async () => {
    const sink = memorySink()
    const root = createLogger({ component: 'svc', sinks: [sink], queueLimit: 5 })
    for (let index = 0; index < 8; index += 1) root.logger.info(`event ${index}`)
    await root.flush()
    expect(sink.events.filter(event => event.level === 'warn')).toEqual([expect.objectContaining({ message: 'log events dropped: queue full' }), expect.objectContaining({ message: 'log events dropped: queue drained', fields: { queueLimit: 5, dropped: 3 } })])
    expect(root.stats().dropped).toBe(3)
  })
})

describe('logger lows (logger-fixes-3, -6, -7, -8, -9, -11, -12, -13)', () => {
  it('logger-fixes-3 redacts credentials in any URL scheme, fragments and bare request targets', async () => {
    const token = 'tok_9f8e7d6c5b4a'
    const event = await logOnce({
      wss: `wss://user:${token}@ws.example.com/?token=${token}`,
      target: `/api/callback?access_token=${token}&state=ok`,
      fragment: `https://app.example.com/cb#access_token=${token}&expires_in=3600`,
      dsn: `postgres://admin:${token}@db.internal/app`,
      google: `https://maps.example.com/api?key=${token}`,
      sas: `https://blob.example.com/c?sv=2024&sig=${token}`,
    })
    expect(JSON.stringify(event)).not.toContain(token)
    expect(event.fields).toMatchObject({ target: '/api/callback?access_token=[redacted]&state=ok', fragment: 'https://app.example.com/cb#access_token=[redacted]&expires_in=3600', dsn: 'postgres://admin:[redacted]@db.internal/app' })
  })

  it('logger-fixes-9 rewrites only the secret value, keeping punctuation and other parameters as written', async () => {
    const event = await logOnce({ note: 'see (https://x.example/?token=abc123&q=a%20b).' })
    expect(event.fields!.note).toBe('see (https://x.example/?token=[redacted]&q=a%20b).')
  })

  it('logger-fixes-6 omits body and content fields by their last key word', async () => {
    const event = await logOnce({ requestBody: 'secret file', responseBody: 'reply', fileContents: 'text', toolPayload: '{}', bodyLength: 12 })
    expect(event.fields).toEqual({ requestBody: '[omitted 11 bytes]', responseBody: '[omitted 5 bytes]', fileContents: '[omitted 4 bytes]', toolPayload: '[omitted 2 bytes]', bodyLength: 12 })
  })

  it('logger-fixes-7 redacts secret-shaped object keys and header values in flat header arrays', async () => {
    const token = 'sk_live_0123456789abcdefghij'
    const event = await logOnce({ sessions: { [token]: 1 }, rawHeaders: ['Cookie', 'sid=abc', 'X-Api-Key', 'k-123', 'Accept', 'json'], header: ['x-api-key', 'k-456'] })
    expect(JSON.stringify(event)).not.toContain(token)
    expect(event.fields).toMatchObject({ rawHeaders: ['Cookie', '[redacted]', 'X-Api-Key', '[redacted]', 'Accept', 'json'], header: ['x-api-key', '[redacted]'] })
  })

  it('logger-fixes-8 keeps a flushing sink from feeding itself and lets another root log from inside a sink', async () => {
    const fallback: string[] = []
    const inner = memorySink()
    const innerRoot = createLogger({ component: 'http-client', sinks: [inner] })
    const outer = memorySink()
    let root: ReturnType<typeof createLogger> | undefined
    const flushing: LogSink = { name: 'flushing', write: async () => { innerRoot.logger.warn('reporter http failed') }, flush: () => { root!.logger.info('flushed') } }
    root = createLogger({ component: 'svc', sinks: [outer, flushing], fallback: line => fallback.push(line) })
    root.logger.error('boom')
    await root.flush()
    await innerRoot.flush()
    expect(outer.events.map(event => event.message)).toEqual(['boom'])
    expect(fallback.filter(line => line.includes('flushed'))).toHaveLength(1)
    expect(inner.events.map(event => event.message)).toEqual(['reporter http failed'])
  })

  it('logger-fixes-11 never throws into the caller for a field it cannot read', async () => {
    const sink = memorySink()
    const root = createLogger({ component: 'svc', sinks: [sink] })
    expect(() => root.logger.info('bad', { bad: { get x() { throw new Error('getter boom') } } })).not.toThrow()
    expect(() => root.logger.info({ not: 'a string' } as unknown as string)).not.toThrow()
    await root.flush()
    expect(sink.events[0]).toMatchObject({ message: 'bad', fields: { '[unloggable]': 'Error' } })
    expect(sink.events).toHaveLength(2)
  })

  it('logger-fixes-12 reports drops without a request correlation id, with the count, and respects the level', async () => {
    const sink = memorySink()
    const root = createLogger({ component: 'svc', sinks: [sink], queueLimit: 3 })
    const scope = createOperationScope({ owner: Symbol('t'), context: { correlationId: 'unrelated-request' } })
    runInScope(scope, () => { for (let index = 0; index < 8; index += 1) root.logger.info(`event ${index}`) })
    await root.flush()
    const warnings = sink.events.filter(event => event.level === 'warn')
    expect(warnings.map(event => [event.message, event.correlationId, event.fields])).toEqual([
      ['log events dropped: queue full', undefined, { queueLimit: 3 }],
      ['log events dropped: queue drained', undefined, { queueLimit: 3, dropped: 5 }],
    ])
    const quiet = memorySink()
    const errorsOnly = createLogger({ component: 'svc', sinks: [quiet], queueLimit: 1, level: 'error' })
    for (let index = 0; index < 4; index += 1) errorsOnly.logger.error(`failure ${index}`)
    await errorsOnly.flush()
    expect(quiet.events.filter(event => event.level === 'warn')).toEqual([])
  })

  it('logger-fixes-13 drops a multibyte character cut by truncation', async () => {
    const sink = memorySink()
    const root = createLogger({ component: 'svc', sinks: [sink], maxStringBytes: 5 })
    root.logger.info('x', { text: 'ab\u{1F600}cd' })
    await root.flush()
    expect(sink.events[0]!.fields!.text).toBe('ab...[truncated 3 bytes]')
  })
})
