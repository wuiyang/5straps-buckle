import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createJsonFileStore } from '../common/adapters/json-file-store.js'
import { configureRootLogger, flushLogs, logFormatFrom, logger, loggerConfigFrom, stderrFormat, withoutCause } from '../common/runtime/log.js'

// The root logger writes asynchronously, so every stderr capture flushes before reading.
async function captureStderr(write: () => void): Promise<Array<Record<string, unknown>>> {
  let text = ''
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { text += String(chunk); return true })
  try {
    write()
    await flushLogs()
  } finally {
    spy.mockRestore()
  }
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
}

afterEach(() => { configureRootLogger({}) })

describe('the Buckle root logger', () => {
  it('writes the runtime event shape to stderr, with seven levels and child bindings', async () => {
    configureRootLogger({ level: 'trace' })
    const lines = await captureStderr(() => {
      logger.trace('traced')
      logger.log('logged as info')
      logger.child({ component: 'workbench', workspaceId: 'one' }).warn('child line', { attempt: 2 })
      logger.fatal('fatal line')
    })

    expect(lines.map(line => [line.level, line.message])).toEqual([['trace', 'traced'], ['info', 'logged as info'], ['warn', 'child line'], ['fatal', 'fatal line']])
    expect(lines[2]).toMatchObject({ component: 'workbench', fields: { workspaceId: 'one', attempt: 2 } })
    expect(lines[0]).toMatchObject({ component: 'buckle', timestamp: expect.any(String) })
  })

  it('keeps secrets, raw authorization headers, file contents and tool payloads out of events by default', async () => {
    const secrets = ['Bearer live-agent-credential-value', 'plain-admin-credential-value', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'owner private file text', 'tool payload text']
    const [line] = await captureStderr(() => logger.error('request refused', {
      authorization: secrets[0],
      adminToken: secrets[1],
      headers: { authorization: secrets[0], 'x-request-id': 'kept' },
      content: secrets[3],
      args: { path: 'notes.txt', content: secrets[4] },
      detail: `forge answered 401 for ${secrets[2]}`,
      path: 'notes.txt',
    }))

    const text = JSON.stringify(line)
    for (const secret of secrets) expect(text).not.toContain(secret)
    expect(line).toMatchObject({ level: 'error', message: 'request refused', fields: { path: 'notes.txt' } })
  })

  it('reads its level and key lists from the environment, refusing an unknown level', () => {
    expect(loggerConfigFrom({})).toEqual({})
    expect(loggerConfigFrom({ BUCKLE_LOG_LEVEL: 'debug', BUCKLE_LOG_OMIT_KEYS: 'diff, patch', BUCKLE_LOG_ALLOW_KEYS: 'tokenCount' })).toEqual({ level: 'debug', omitKeys: ['diff', 'patch'], allowKeys: ['tokenCount'] })
    expect(() => loggerConfigFrom({ BUCKLE_LOG_LEVEL: 'loud' })).toThrow('BUCKLE_LOG_LEVEL must be one of trace, debug, info, warn, error, fatal')
  })

  it('keeps credential keys redacted even when BUCKLE_LOG_ALLOW_KEYS names them', async () => {
    configureRootLogger(loggerConfigFrom({ BUCKLE_LOG_ALLOW_KEYS: 'adminToken, authorization, reportToken, content' }))
    const [line] = await captureStderr(() => logger.info('allowed keys', { adminToken: 'plain-admin-credential-value', authorization: 'plain-header-value', reportToken: 'plain-report-value', content: 'lifted file text' }))
    expect(line).toMatchObject({ fields: { adminToken: '[redacted]', authorization: '[redacted]', reportToken: '[redacted]', content: 'lifted file text' } })
  })

  it('drops events below the configured level', async () => {
    configureRootLogger(loggerConfigFrom({ BUCKLE_LOG_LEVEL: 'warn' }))
    const lines = await captureStderr(() => {
      logger.info('quiet')
      logger.warn('loud')
    })
    expect(lines.map(line => line.message)).toEqual(['loud'])
  })
})

// The CLI display slice, C1: human lines for a person at a terminal, JSON wherever stderr is not one, so every pipe,
// test, service, and MCP client reads what it read before; one override, BUCKLE_LOG_FORMAT; the service file always JSON.
describe('the format of the log on stderr', () => {
  const terminal = (isTTY: boolean) => Object.defineProperty(process.stderr, 'isTTY', { value: isTTY, configurable: true, writable: true })
  afterEach(() => {
    Reflect.deleteProperty(process.stderr, 'isTTY')
    vi.unstubAllEnvs()
  })

  async function stderrText(write: () => void): Promise<string> {
    let text = ''
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { text += String(chunk); return true })
    try {
      write()
      await flushLogs()
    } finally {
      spy.mockRestore()
    }
    return text
  }

  it('reads BUCKLE_LOG_FORMAT, json or human, by its own function, refusing any other value', () => {
    expect(logFormatFrom({})).toBeUndefined()
    expect(logFormatFrom({ BUCKLE_LOG_FORMAT: '' })).toBeUndefined()
    expect(logFormatFrom({ BUCKLE_LOG_FORMAT: ' human ' })).toBe('human')
    expect(logFormatFrom({ BUCKLE_LOG_FORMAT: 'json' })).toBe('json')
    expect(() => logFormatFrom({ BUCKLE_LOG_FORMAT: 'pretty' })).toThrow('BUCKLE_LOG_FORMAT must be json or human')
    // The logger's own config does not carry it: an unset environment still reads as {}.
    expect(loggerConfigFrom({ BUCKLE_LOG_FORMAT: 'human' })).toEqual({})
  })

  it('is human where stderr is a terminal and JSON where it is not, unless the override names one', () => {
    expect(stderrFormat(undefined, { isTTY: true })).toBe('human')
    expect(stderrFormat(undefined, {})).toBe('json')
    expect(stderrFormat('json', { isTTY: true })).toBe('json')
    expect(stderrFormat('human', { isTTY: false })).toBe('human')
  })

  it('writes a time-stamped human line to a terminal, and a JSON line to a pipe', async () => {
    terminal(true)
    configureRootLogger({})
    expect(await stderrText(() => logger.info('to a person'))).toMatch(/^\d\d:\d\d:\d\d \[info\] to a person\n$/)
    terminal(false)
    configureRootLogger({})
    expect(JSON.parse(await stderrText(() => logger.info('to a machine')))).toMatchObject({ level: 'info', component: 'buckle', message: 'to a machine' })
  })

  it('follows the shell\'s override before buckle.env is read, and the format main names after', async () => {
    vi.stubEnv('BUCKLE_LOG_FORMAT', 'human')
    configureRootLogger({})
    expect(await stderrText(() => logger.warn('before the file'))).toMatch(/^\d\d:\d\d:\d\d \[warn\] before the file\n$/)
    // A value it does not know leaves the TTY rule in place here; main refuses it once it reads the file.
    vi.stubEnv('BUCKLE_LOG_FORMAT', 'pretty')
    configureRootLogger({})
    expect(JSON.parse(await stderrText(() => logger.info('unknown value')))).toMatchObject({ message: 'unknown value' })
    terminal(true)
    configureRootLogger({}, { format: 'json' })
    expect(JSON.parse(await stderrText(() => logger.info('named json')))).toMatchObject({ message: 'named json' })
  })

  it('writes the service file as JSON lines whatever the format says', async () => {
    vi.stubEnv('BUCKLE_LOG_FORMAT', 'human')
    terminal(true)
    const root = mkdtempSync(join(tmpdir(), 'buckle-log-format-'))
    try {
      const file = join(root, 'logs', 'buckle.log')
      configureRootLogger({}, { file })
      logger.info('to the file')
      await flushLogs()
      expect(readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as unknown)).toEqual([expect.objectContaining({ level: 'info', message: 'to the file' })])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the logger\'s fallback line JSON when the human sink fails', async () => {
    configureRootLogger({}, { format: 'human' })
    let text = ''
    const spy = vi.spyOn(process.stderr, 'write')
      .mockImplementationOnce(() => { throw new Error('stderr is gone') })
      .mockImplementation(chunk => { text += String(chunk); return true })
    try {
      logger.info('lost line')
      await flushLogs()
    } finally {
      spy.mockRestore()
    }
    expect(JSON.parse(text)).toMatchObject({ level: 'error', component: 'logger', message: 'Log sink stderr-human failed', dropped: { level: 'info', message: 'lost line' } })
  })
})

// Slice 7 review R7-RR-3: a state file's parse failure carries V8's SyntaxError as its cause, whose message quotes the
// file around the fault, and the logger follows a cause. A log line keeps the failure's name, own message and stack.
describe('an error in a log line', () => {
  it('keeps the name and own message of a state file failure, and none of the text its cause quotes', async () => {
    configureRootLogger(loggerConfigFrom({}))
    const root = mkdtempSync(join(tmpdir(), 'buckle-logged-error-'))
    try {
      const filePath = join(root, 'approvals.json')
      writeFileSync(filePath, '{"pending":[{"subject": psql -c DROP TABLE accounts}]}')
      const failure = (() => {
        try {
          createJsonFileStore({ filePath, schema: z.object({ pending: z.array(z.unknown()) }), fallback: { pending: [] } }).read()
        } catch (error) {
          return error
        }
        throw new Error('expected the damaged file to fail')
      })()
      const lines = await captureStderr(() => {
        logger.warn('kept', { error: withoutCause(failure) })
        // The error itself, as the sites slice 7b review RRL-1 named log it: the store throws it without the cause.
        logger.warn('whole', { error: failure })
      })
      const kept = lines.find(line => line.message === 'kept')
      expect(kept?.error).toMatchObject({ name: 'StateFileError', message: `State file is unreadable or invalid: ${filePath}; owner repair is required` })
      expect(kept?.error).not.toHaveProperty('cause')
      expect(JSON.stringify(kept)).not.toMatch(/psql|DROP|accounts/)
      const whole = lines.find(line => line.message === 'whole')
      expect(whole?.error).toMatchObject({ name: 'StateFileError' })
      expect(JSON.stringify(whole)).not.toMatch(/psql|DROP|accounts/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps only the name of a SyntaxError, whose own message quotes its input, and names a thrown non-error', () => {
    const failure = (() => {
      try {
        JSON.parse('{"subject": psql -c DROP}')
      } catch (error) {
        return error
      }
      throw new Error('expected a syntax error')
    })()
    const kept = withoutCause(failure) as Error
    expect([kept.name, kept.message, kept.stack]).toEqual(['SyntaxError', '', 'SyntaxError'])
    expect(withoutCause('a string')).toBe('Unknown error')
    const ranged = withoutCause(new RangeError('out of range', { cause: new Error('inner') })) as Error
    expect([ranged.name, ranged.message, ranged.cause]).toEqual(['RangeError', 'out of range', undefined])
  })
})
