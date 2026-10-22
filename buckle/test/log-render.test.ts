import type { LogEvent } from '@5straps/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDateSeparators, renderEvent } from '../common/runtime/log-render.js'

// The CLI display slice, C2: the lines a person reads at a terminal for one log event. The JSON a machine reads is the
// event itself, which nothing here changes. Every case names its zone, so no test reads the machine's own.

afterEach(() => { vi.unstubAllEnvs() })

const event = (fields: Partial<LogEvent> = {}): LogEvent => ({ timestamp: '2026-10-21T14:22:00.159Z', level: 'info', component: 'buckle', message: 'something happened', ...fields })
const quiet = { verbose: false }
const verbose = { verbose: true }

describe('a log line for a person', () => {
  it('reads HH:MM:SS [level] message in the device\'s local time, with no component column', () => {
    vi.stubEnv('TZ', 'Asia/Kuala_Lumpur')
    expect(renderEvent(event(), quiet)).toEqual(['22:22:00 [info] something happened'])
    vi.stubEnv('TZ', 'Europe/London')
    expect(renderEvent(event(), quiet)).toEqual(['15:22:00 [info] something happened'])
    vi.stubEnv('TZ', 'America/New_York')
    expect(renderEvent(event({ timestamp: '2026-10-21T03:04:05.000Z' }), quiet)).toEqual(['23:04:05 [info] something happened'])
  })

  it('tags each level in lower case', () => {
    vi.stubEnv('TZ', 'UTC')
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) expect(renderEvent(event({ level }), quiet)![0]).toBe(`14:22:00 [${level}] something happened`)
  })

  it('shows the correlation id only at debug or trace', () => {
    vi.stubEnv('TZ', 'UTC')
    expect(renderEvent(event({ correlationId: 'c-1' }), quiet)).toEqual(['14:22:00 [info] something happened'])
    expect(renderEvent(event({ correlationId: 'c-1' }), verbose)).toEqual(['14:22:00 [info] something happened correlationId=c-1'])
  })
})

describe('the date separator', () => {
  it('comes before the first line and again whenever the local date changes, never twice for one day', () => {
    vi.stubEnv('TZ', 'Asia/Kuala_Lumpur')
    const separators = createDateSeparators()
    expect(separators(new Date('2026-10-21T14:22:00Z'))).toEqual(['--- 2026-10-21 ---'])
    expect(separators(new Date('2026-10-21T15:59:59Z'))).toEqual([])
    // Local midnight in Kuala Lumpur is 16:00 UTC.
    expect(separators(new Date('2026-10-21T16:00:00Z'))).toEqual(['--- 2026-10-22 ---'])
    expect(separators(new Date('2026-10-21T16:00:01Z'))).toEqual([])
  })

  it('adds none when the clock falls back an hour inside one local day', () => {
    vi.stubEnv('TZ', 'America/New_York')
    const newYork = createDateSeparators()
    // 01:30 twice on 2026-11-01: daylight time, then standard time.
    expect(renderEvent(event({ timestamp: '2026-11-01T05:30:00Z' }), quiet)![0]).toMatch(/^01:30:00 /)
    expect(renderEvent(event({ timestamp: '2026-11-01T06:30:00Z' }), quiet)![0]).toMatch(/^01:30:00 /)
    expect([...newYork(new Date('2026-11-01T05:30:00Z')), ...newYork(new Date('2026-11-01T06:30:00Z'))]).toEqual(['--- 2026-11-01 ---'])
    vi.stubEnv('TZ', 'Europe/London')
    const london = createDateSeparators()
    expect(renderEvent(event({ timestamp: '2026-10-25T00:30:00Z' }), quiet)![0]).toMatch(/^01:30:00 /)
    expect(renderEvent(event({ timestamp: '2026-10-25T01:30:00Z' }), quiet)![0]).toMatch(/^01:30:00 /)
    expect([...london(new Date('2026-10-25T00:30:00Z')), ...london(new Date('2026-10-25T01:30:00Z'))]).toEqual(['--- 2026-10-25 ---'])
  })
})

describe('what an agent may have chosen, in a log line', () => {
  // JSON.stringify escapes ESC but passes DEL, C1 and bidi characters through raw: the console is never weaker than it.
  const hostile = 'a\u007fb\u009b2Jc\u202ed\u001b[1Ae\u2028f'
  const control = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202e]/
  const shown = 'a\\u007fb\\u009b2Jc\\u202ed\\u001b[1Ae\\u2028f'

  it('escapes DEL, C1, bidi, and line separator characters in the message, fields, and errors', () => {
    vi.stubEnv('TZ', 'UTC')
    const lines = renderEvent(event({ level: 'fatal', message: hostile, fields: { subject: hostile, nested: { value: hostile }, [hostile]: 1 }, error: { name: hostile, message: hostile, code: hostile, stack: `${hostile}\n    at ${hostile}` } }), quiet)!
    for (const line of lines) expect(line).not.toMatch(control)
    expect(lines[0]).toBe(`14:22:00 [fatal] ${shown}: ${shown}: ${shown} (${shown}) subject=${shown} nested={"value":"${shown}"} ${shown}=1`)
    expect(lines).toContain(`    at ${shown}`)
  })

  it('splits a multi-line value onto indented lines, each escaped, so a carriage return cannot rewrite one', () => {
    vi.stubEnv('TZ', 'UTC')
    expect(renderEvent(event({ message: 'Workspaces served', fields: { workspaces: 'Serving 1 workspace:\n  site\r  forged\n    id      w-1' } }), quiet)).toEqual([
      '14:22:00 [info] Workspaces served',
      '  workspaces:',
      '    Serving 1 workspace:',
      '      site\\u000d  forged',
      '        id      w-1',
    ])
  })
})

describe('fields and errors', () => {
  it('prints scalars as key=value and objects as one line of JSON, leaving out what is undefined', () => {
    vi.stubEnv('TZ', 'UTC')
    expect(renderEvent(event({ message: '5straps Buckle listening', fields: { host: '127.0.0.1', port: 4320, ready: false, none: null, gone: undefined, workspacesOnline: ['w-1', 'w-2'] } }), quiet)).toEqual([
      '14:22:00 [info] 5straps Buckle listening host=127.0.0.1 port=4320 ready=false none=null workspacesOnline=["w-1","w-2"]',
    ])
  })

  it('names an error on one line at warn and error, with its code, and no stack', () => {
    vi.stubEnv('TZ', 'UTC')
    const error = { name: 'Error', message: 'listen EADDRINUSE: address already in use 127.0.0.1:4320', code: 'EADDRINUSE', stack: 'Error: listen EADDRINUSE: address already in use 127.0.0.1:4320\n    at Server.setupListenHandle (node:net:1937:16)' }
    expect(renderEvent(event({ level: 'warn', message: 'Could not listen', error }), quiet)).toEqual(['14:22:00 [warn] Could not listen: Error: listen EADDRINUSE: address already in use 127.0.0.1:4320 (EADDRINUSE)'])
    expect(renderEvent(event({ level: 'error', message: 'Kept', error: { name: 'SyntaxError', message: '' } }), quiet)).toEqual(['14:22:00 [error] Kept: SyntaxError'])
  })

  it('adds the indented stack at fatal, and at every level when the log is at debug or trace', () => {
    vi.stubEnv('TZ', 'UTC')
    const error = { name: 'Error', message: 'boom', stack: 'Error: boom\n    at start (main.js:1:1)\n    at run (main.js:2:2)' }
    expect(renderEvent(event({ level: 'fatal', message: 'Buckle failed to start', error }), quiet)).toEqual(['14:22:00 [fatal] Buckle failed to start: Error: boom', '    at start (main.js:1:1)', '    at run (main.js:2:2)'])
    expect(renderEvent(event({ level: 'warn', message: 'Retrying', error }), verbose)).toEqual(['14:22:00 [warn] Retrying: Error: boom', '    at start (main.js:1:1)', '    at run (main.js:2:2)'])
  })
})

describe('the request lines', () => {
  it('shows request completed as the path, the words, and the time, and the outcome only where it did not end well', () => {
    vi.stubEnv('TZ', 'Asia/Kuala_Lumpur')
    const completed = (outcome: string) => renderEvent(event({ message: 'request completed', correlationId: 'c-1', fields: { method: 'POST', path: '/mcp', outcome, durationMs: 159 } }), quiet)
    expect(completed('streamed 200')).toEqual(['22:22:00 [info] /mcp request completed (159ms)'])
    expect(completed('ok')).toEqual(['22:22:00 [info] /mcp request completed (159ms)'])
    expect(completed('ok 204')).toEqual(['22:22:00 [info] /mcp request completed (159ms)'])
    expect(completed('error 401')).toEqual(['22:22:00 [info] /mcp request completed (159ms), error 401'])
    expect(completed('error')).toEqual(['22:22:00 [info] /mcp request completed (159ms), error'])
  })

  it('shows request finished only for a request that ran no operation, as the route, the status, and the time', () => {
    vi.stubEnv('TZ', 'UTC')
    const finished = (fields: Record<string, unknown>) => renderEvent(event({ message: 'request finished', fields: { method: 'POST', route: '/mcp', status: 200, durationMs: 161, correlationId: 'c-2', ...fields } }), quiet)
    // Its operation twin, request completed, already says it.
    expect(finished({ actor: 'agent:node', workspaceId: 'w-1' })).toBeNull()
    // A guard's refusal, before any operation: the only line it gets.
    expect(finished({ status: 401, durationMs: 2 })).toEqual(['14:22:00 [info] /mcp 401 (2ms)'])
    expect(finished({ route: null, status: 404, durationMs: 1 })).toEqual(['14:22:00 [info] no route 404 (1ms)'])
  })

  it('escapes the path a caller chose', () => {
    vi.stubEnv('TZ', 'UTC')
    expect(renderEvent(event({ message: 'request completed', fields: { method: 'GET', path: '/v1/\u009b2J', outcome: 'ok', durationMs: 3 } }), quiet)).toEqual(['14:22:00 [info] /v1/\\u009b2J request completed (3ms)'])
  })
})

describe('the startup and shutdown steps', () => {
  it('show at debug or trace alone, while listening, the stop request, and stopped show at info', () => {
    vi.stubEnv('TZ', 'UTC')
    expect(renderEvent(event({ message: 'cli:call listener registered' }), quiet)).toBeNull()
    expect(renderEvent(event({ message: 'close step', fields: { stage: 'accept', name: 'http server' } }), quiet)).toBeNull()
    expect(renderEvent(event({ message: 'close step', fields: { stage: 'accept', name: 'http server' } }), verbose)).toEqual(['14:22:00 [info] close step stage=accept name=http server'])
    expect(renderEvent(event({ message: 'cli:call listener registered' }), verbose)).toEqual(['14:22:00 [info] cli:call listener registered'])
    expect(renderEvent(event({ message: 'Shutdown requested', fields: { signal: 'SIGINT' } }), quiet)).toEqual(['14:22:00 [info] Shutdown requested signal=SIGINT'])
    expect(renderEvent(event({ message: '5straps Buckle stopped' }), quiet)).toEqual(['14:22:00 [info] 5straps Buckle stopped'])
  })
})
