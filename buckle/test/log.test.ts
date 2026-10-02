import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createJsonFileStore } from '../common/adapters/json-file-store.js'
import { configureRootLogger, flushLogs, logger, loggerConfigFrom, withoutCause } from '../common/runtime/log.js'

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
