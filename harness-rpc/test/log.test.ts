import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureRootLogger, flushLogs, logger, loggerConfigFrom } from '../common/runtime/log.js'

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

  it('drops events below the configured level', async () => {
    configureRootLogger(loggerConfigFrom({ BUCKLE_LOG_LEVEL: 'warn' }))
    const lines = await captureStderr(() => {
      logger.info('quiet')
      logger.warn('loud')
    })
    expect(lines.map(line => line.message)).toEqual(['loud'])
  })
})
