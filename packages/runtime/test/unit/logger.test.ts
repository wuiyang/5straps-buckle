import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createErrorReporterSink, createHumanSink, createLogger, createOperationScope, createRotatingFileSink, createStderrJsonSink, runInScope, type LogEvent, type LogSink } from '../../src/index.js'

function memorySink(): LogSink & { events: LogEvent[] } {
  const events: LogEvent[] = []
  return { name: 'memory', events, write: (event) => { events.push(event) } }
}

describe('F52 logger contract', () => {
  it('treats log as an info alias and filters below the threshold', async () => {
    const sink = memorySink()
    const root = createLogger({ component: 'test', sinks: [sink], level: 'info' })
    root.logger.debug('hidden')
    root.logger.log('via log')
    root.logger.fatal('fatal only records severity')
    await root.flush()
    expect(sink.events.map(event => [event.level, event.message])).toEqual([['info', 'via log'], ['fatal', 'fatal only records severity']])
  })

  it('takes the correlation id from the active operation scope and merges child bindings', async () => {
    const sink = memorySink()
    const root = createLogger({ component: 'server', sinks: [sink] })
    const scope = createOperationScope({ owner: Symbol('t'), context: { correlationId: 'corr-7' } })
    runInScope(scope, () => root.logger.child({ component: 'mcp', tool: 'fs' }).info('called', { durationMs: 3 }))
    await root.flush()
    expect(sink.events[0]).toMatchObject({ component: 'mcp', correlationId: 'corr-7', fields: { tool: 'fs', durationMs: 3 } })
  })

  it('redacts authorization values, token-like strings, file contents and tool payloads', async () => {
    const sink = memorySink()
    const root = createLogger({ component: 'test', sinks: [sink] })
    const token = 'a'.repeat(64)
    root.logger.warn(`rejected Bearer ${token}`, {
      headers: { authorization: 'Bearer abc.def', 'x-api-key': 'k' },
      note: `agent token ${token}`,
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
      content: 'SECRET FILE BODY',
      arguments: { path: '/etc/passwd' },
    })
    await root.flush()
    const serialized = JSON.stringify(sink.events)
    expect(serialized).not.toContain(token)
    expect(serialized).not.toContain('abc.def')
    expect(serialized).not.toContain('SECRET FILE BODY')
    expect(serialized).not.toContain('/etc/passwd')
    expect(serialized).not.toContain('eyJhbGci')
    expect(sink.events[0]!.fields).toMatchObject({ headers: { authorization: '[redacted]', 'x-api-key': '[redacted]' }, content: '[omitted 16 bytes]', arguments: '[omitted object]' })
  })

  it('lets a deployment opt a key back in explicitly', async () => {
    const sink = memorySink()
    const root = createLogger({ component: 'test', sinks: [sink], allowKeys: ['body'] })
    root.logger.info('debugging', { body: 'visible' })
    await root.flush()
    expect(sink.events[0]!.fields).toEqual({ body: 'visible' })
  })

  it('never lifts redaction for a credential key, whatever allowKeys lists', async () => {
    const sink = memorySink()
    const root = createLogger({ component: 'test', sinks: [sink], allowKeys: ['adminToken', 'authorization', 'apiKey', 'clientSecret', 'password'] })
    root.logger.info('debugging', { adminToken: 'plain-admin-value', authorization: 'plain-header', apiKey: 'plain-key', clientSecret: 'plain-secret', password: 'plain-password' })
    await root.flush()
    expect(sink.events[0]!.fields).toEqual({ adminToken: '[redacted]', authorization: '[redacted]', apiKey: '[redacted]', clientSecret: '[redacted]', password: '[redacted]' })
  })

  it('truncates a 1 MB field', async () => {
    const sink = memorySink()
    const root = createLogger({ component: 'test', sinks: [sink] })
    root.logger.info('big', { detail: 'x'.repeat(1_048_576) })
    await root.flush()
    const detail = sink.events[0]!.fields!.detail as string
    expect(Buffer.byteLength(detail)).toBeLessThan(9_000)
    expect(detail).toMatch(/\[truncated 1040384 bytes\]$/)
  })

  it('redacts a token that straddles the truncation boundary', async () => {
    const sink = memorySink()
    const root = createLogger({ component: 'test', sinks: [sink], maxStringBytes: 100 })
    const token = '0123456789abcdef'.repeat(4)
    root.logger.info('cut', { detail: `${'.'.repeat(80)}${token}${'.'.repeat(200)}` })
    await root.flush()
    const detail = sink.events[0]!.fields!.detail as string
    expect(detail).not.toMatch(/0123456789/)
    expect(detail).toContain('[redacted]')
  })

  it('normalizes errors with code, cause and stack, and marks repeats', async () => {
    const sink = memorySink()
    const root = createLogger({ component: 'test', sinks: [sink] })
    const error = Object.assign(new Error('write failed', { cause: new Error('disk full') }), { code: 'EIO' })
    root.logger.error('first', { error })
    root.logger.error('second', { error })
    root.logger.error('odd', { error: 'plain string' })
    await root.flush()
    expect(sink.events[0]!.error).toMatchObject({ name: 'Error', message: 'write failed', code: 'EIO', cause: { message: 'disk full' } })
    expect(sink.events[0]!.error!.stack).toContain('write failed')
    expect(sink.events[1]!.error!.repeated).toBe(true)
    expect(sink.events[2]!.error).toEqual({ name: 'NonError', message: 'plain string' })
  })
})

describe('F53 logger sinks', () => {
  it('writes one JSON line per event to the stderr sink', async () => {
    const stream = new PassThrough()
    const chunks: string[] = []
    stream.on('data', chunk => chunks.push(String(chunk)))
    const root = createLogger({ component: 'svc', sinks: [createStderrJsonSink({ stream })] })
    root.logger.info('started', { port: 1 })
    await root.close()
    const event = JSON.parse(chunks.join('').trim()) as LogEvent
    expect(event).toMatchObject({ level: 'info', component: 'svc', message: 'started', fields: { port: 1 } })
  })

  it('renders human lines for an interactive CLI', async () => {
    const stream = new PassThrough()
    const chunks: string[] = []
    stream.on('data', chunk => chunks.push(String(chunk)))
    const root = createLogger({ component: 'cli', sinks: [createHumanSink({ stream })] })
    root.logger.warn('slow', { ms: 900 })
    await root.flush()
    expect(chunks.join('')).toMatch(/^\d\d:\d\d:\d\d WARN  \[cli\] slow ms=900\n$/)
  })

  it('rotates the file sink within bounded disk use and creates files 0600 in a 0700 directory', async () => {
    const directory = join(await mkdtemp(join(tmpdir(), 'log-')), 'logs')
    const path = join(directory, 'buckle.log')
    const root = createLogger({ component: 'svc', sinks: [createRotatingFileSink({ path, maxBytes: 400, maxFiles: 2 })] })
    for (let index = 0; index < 30; index += 1) root.logger.info(`event ${index}`)
    await root.close()
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(existsSync(`${path}.1`)).toBe(true)
    expect(existsSync(`${path}.2`)).toBe(true)
    expect(existsSync(`${path}.3`)).toBe(false)
    for (const file of [path, `${path}.1`, `${path}.2`]) expect(statSync(file).size).toBeLessThanOrEqual(400)
    expect(readFileSync(path, 'utf8')).toContain('event 29')
  })

  it('reports a failing sink through the fallback without recursion and keeps other sinks working', async () => {
    const fallback: string[] = []
    const good = memorySink()
    let root: ReturnType<typeof createLogger> | undefined
    const failing: LogSink = { name: 'broken', write: () => {
      root!.logger.error('logged from inside the sink')
      throw new Error('sink down')
    } }
    root = createLogger({ component: 'svc', sinks: [failing, good], fallback: line => fallback.push(line) })
    root.logger.info('one')
    root.logger.info('two')
    await root.flush()
    expect(good.events.map(event => event.message)).toEqual(['one', 'two'])
    expect(root.stats().sinkFailures).toBe(2)
    expect(fallback.filter(line => line.includes('Log sink broken failed'))).toHaveLength(2)
    expect(fallback.filter(line => line.includes('logged from inside the sink'))).toHaveLength(2)
  })

  it('counts drops when the bounded queue is full and flushes the rest', async () => {
    const sink = memorySink()
    const root = createLogger({ component: 'svc', sinks: [sink], queueLimit: 5 })
    for (let index = 0; index < 8; index += 1) root.logger.info(`event ${index}`)
    await root.flush()
    expect(sink.events.filter(event => event.level === 'info')).toHaveLength(5)
    expect(root.stats().dropped).toBe(3)
  })

  it('forwards errors to a reporter adapter once per error object', async () => {
    const reported: LogEvent[] = []
    let flushed = false
    const root = createLogger({ component: 'svc', sinks: [createErrorReporterSink({ reporter: { report: event => { reported.push(event) }, flush: () => { flushed = true } } })] })
    const error = new Error('boom')
    root.logger.warn('not an error level')
    root.logger.error('app hook', { error })
    root.logger.error('nitro hook', { error })
    await root.flush()
    expect(reported.map(event => event.message)).toEqual(['app hook'])
    expect(flushed).toBe(true)
  })
})
