import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogQueue } from '@5straps/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createJsonFileStore } from '../common/adapters/json-file-store.js'
import { LOG_BATCH_LIMIT, LOG_CLOSE_DEADLINE_MS, LOG_WRITE_DEADLINE_MS, PROCESS_LOG_QUEUE, processLogBudget } from '../common/runtime/log-budget.js'
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

  it('stops flushing at the close deadline while a sink fails its retries, so a command still exits', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const failing = configureRootLogger({}, { sink: { name: 'failing', write: () => { throw new Error('disk full') } } })
    try {
      logger.info('a line the sink will not take')
      const started = performance.now()
      await flushLogs()
      expect(performance.now() - started).toBeLessThan(LOG_CLOSE_DEADLINE_MS + 1_000)
    } finally {
      // Its line leaves the process's budget, which the next test fills.
      await failing.close({ deadlineMs: 1 })
      stderr.mockRestore()
    }
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

  it('keeps the logger\'s fallback line JSON when the human sink fails, and writes the line when it tries again', async () => {
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
    const [failed, retried] = text.split('\n').filter(Boolean)
    expect(JSON.parse(failed!)).toMatchObject({ level: 'error', component: 'logger', message: 'Log sink stderr-human failed', event: { level: 'info', message: 'lost line' } })
    expect(retried).toMatch(/^\d\d:\d\d:\d\d \[info\] lost line$/)
  })

  // C2: the human sink renders the event the logger already redacted, so no sink can show more than the JSON does.
  it('keeps credentials out of a human line, as out of a JSON one', async () => {
    configureRootLogger({}, { format: 'human' })
    const text = await stderrText(() => logger.warn('forge refused', { authorization: 'Bearer live-agent-credential-value', detail: 'forge answered 401 for ghp_abcdefghijklmnopqrstuvwxyz0123', path: 'notes.txt' }))
    expect(text).not.toContain('live-agent-credential-value')
    expect(text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123')
    expect(text).toMatch(/^\d\d:\d\d:\d\d \[warn\] forge refused authorization=\[redacted\] detail=forge answered 401 for \S+ path=notes\.txt\n$/)
  })

  it('shows the startup and shutdown steps only where the log is at debug or trace', async () => {
    configureRootLogger({}, { format: 'human' })
    expect(await stderrText(() => logger.info('close step', { stage: 'accept', name: 'http server' }))).toBe('')
    configureRootLogger({ level: 'debug' }, { format: 'human' })
    expect(await stderrText(() => logger.info('close step', { stage: 'accept', name: 'http server' }))).toMatch(/^\d\d:\d\d:\d\d \[info\] close step stage=accept name=http server\n$/)
  })
})

// Every log the process writes shares one budget of 30 held entries, the oldest dropped, and a failed write is tried 3
// more times before its entries drop.
describe('what the process holds of its logs', () => {
  const range = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => `line ${from + index}`)

  afterEach(() => { vi.useRealTimers() })

  it('holds 30 lines of a burst on stderr, drops the oldest, warns once, and writes the count first', async () => {
    configureRootLogger({}, { format: 'json' })
    let held = 0
    const lines = await captureStderr(() => {
      for (const line of range(0, 40)) logger.info(line)
      held = processLogBudget.held()
    })
    expect(held).toBe(30)
    expect(lines[0]).toMatchObject({ level: 'warn', component: 'logger', message: 'Log events dropped', fields: { destination: 'stderr-json', reason: 'full', limit: 30 } })
    expect(lines.slice(1).map(line => line.message)).toEqual(['log events dropped', ...range(10, 40)])
    expect(lines[1]).toMatchObject({ level: 'warn', component: 'buckle', fields: { destination: 'stderr-json', dropped: 10 } })
  })

  it('holds 30 lines of a burst on the service file too, and warns on stderr, not in the file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-log-budget-'))
    try {
      const file = join(root, 'logs', 'buckle.log')
      configureRootLogger({}, { file })
      let held = 0
      const warnings = await captureStderr(() => {
        for (const line of range(0, 40)) logger.info(line)
        held = processLogBudget.held()
      })
      expect(held).toBe(30)
      expect(warnings).toEqual([expect.objectContaining({ message: 'Log events dropped', fields: { destination: 'rotating-file', reason: 'full', limit: 30 } })])
      const stored = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
      expect(stored.map(line => line.message)).toEqual(['log events dropped', ...range(10, 40)])
      expect(stored[0]).toMatchObject({ fields: { destination: 'rotating-file', dropped: 10 } })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('shares the budget with every other log of the process, dropping the oldest whichever log holds it', async () => {
    configureRootLogger({}, { format: 'json' })
    const actions = createLogQueue<string>({ destination: 'actions.jsonl', budget: processLogBudget, write: () => new Promise<void>(() => {}) })
    try {
      for (const line of range(0, 20)) actions.push(line)
      let held = 0
      const lines = await captureStderr(() => {
        for (const line of range(0, 20)) logger.info(line)
        held = processLogBudget.held()
      })
      expect(held).toBe(30)
      expect(lines.map(line => line.message)).toEqual(range(0, 20))
      expect(actions.stats().dropped).toBe(10)
    } finally {
      await actions.close({ deadlineMs: 1 })
    }
  })

  describe('beside an action log whose writer stalled', () => {
    function stalledActions() {
      const batches: string[][] = []
      const queue = createLogQueue<string>({ destination: 'actions.jsonl', ...PROCESS_LOG_QUEUE, write: (batch) => { batches.push([...batch]); return new Promise<void>(() => {}) } })
      for (const line of range(0, 30)) queue.push(line)
      return { queue, batches }
    }

    it('keeps the node log\'s newest lines, as the stalled log hands its writer one batch at most', async () => {
      configureRootLogger({}, { format: 'json' })
      const actions = stalledActions()
      try {
        await new Promise(resolve => setImmediate(resolve))
        const lines = await captureStderr(() => { for (const line of range(30, 50)) logger.info(line) })
        expect(lines.map(line => line.message)).toEqual(range(30, 50))
        expect(actions.batches).toEqual([range(0, LOG_BATCH_LIMIT)])
      } finally {
        await actions.queue.close({ deadlineMs: 1 })
      }
    })

    it('drops that batch first, oldest first, once its write is past the deadline', async () => {
      configureRootLogger({}, { format: 'json' })
      const actions = stalledActions()
      try {
        await new Promise(resolve => setTimeout(resolve, LOG_WRITE_DEADLINE_MS + 100))
        const lines = await captureStderr(() => { for (const line of range(30, 60)) logger.info(line) })
        expect(lines.map(line => line.message)).toEqual(range(30, 60))
        expect(actions.queue.stats()).toMatchObject({ dropped: 30, failures: 1 })
      } finally {
        await actions.queue.close({ deadlineMs: 1 })
      }
    })
  })

  it('tries a failed line again after 250 ms, 1 s, and 4 s, then drops it and says so before the next line', async () => {
    vi.useFakeTimers()
    configureRootLogger({}, { format: 'json' })
    let failures = 4
    let attempts = 0
    let text = ''
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      const line = String(chunk)
      if (line.includes('"component":"buckle","message":"lost line"')) {
        attempts += 1
        if (failures-- > 0) throw new Error('stderr is gone')
      }
      text += line
      return true
    })
    try {
      logger.info('lost line')
      await vi.advanceTimersByTimeAsync(0)
      expect(attempts).toBe(1)
      await vi.advanceTimersByTimeAsync(249)
      expect(attempts).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(attempts).toBe(2)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(attempts).toBe(3)
      await vi.advanceTimersByTimeAsync(4_000)
      expect(attempts).toBe(4)
      logger.info('next line')
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      spy.mockRestore()
    }
    const lines = text.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
    expect(lines.map(line => line.message)).toEqual([...Array<string>(4).fill('Log sink stderr-json failed'), 'Log events dropped', 'log events dropped', 'next line'])
    expect(lines[4]).toMatchObject({ fields: { destination: 'stderr-json', reason: 'failed', limit: 30 } })
    expect(lines[5]).toMatchObject({ fields: { dropped: 1 } })
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
