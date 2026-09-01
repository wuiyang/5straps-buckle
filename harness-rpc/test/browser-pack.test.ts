import type { JsonObject } from '@5straps/protocol'
import { describe, expect, it } from 'vitest'
import { createBrowserPack, type BrowserPackOptions } from '../src/packs/browser/index.js'
import type { ProcessRequest, ProcessResult } from '../src/ports/process-runner.js'

function stubResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { exitCode: 0, signal: null, stdout: '{"success":true}', stderr: '', truncated: false, timedOut: false, ...overrides }
}

async function run(input: JsonObject, options: Partial<BrowserPackOptions> = {}, result = stubResult()) {
  const calls: ProcessRequest[] = []
  const pack = createBrowserPack({
    cwd: '/work',
    agentBrowserCommand: 'agent-browser',
    headed: false,
    available: true,
    runProcess: async request => {
      calls.push(request)
      return result
    },
    ...options,
  })

  const tool = pack.tools[0]
  if (!tool) throw new Error('the browser pack registered no tool')
  const output = await tool.prepare(input).execute({
    requestId: 'r1',
    sessionId: 's1',
    timeoutMs: 1000,
    signal: new AbortController().signal,
  })
  return { args: calls[0]?.args ?? [], output }
}

describe('the arguments the browser pack builds', () => {
  it('puts the subcommand first and its positionals next, which is the order agent-browser wants', async () => {
    const { args } = await run({ command: 'open', args: ['https://example.com'] })
    expect(args.slice(0, 2)).toEqual(['open', 'https://example.com'])
  })

  it('always asks for JSON, so output can be parsed rather than scraped', async () => {
    const { args } = await run({ command: 'snapshot', args: ['-i'] })
    expect(args).toContain('--json')
  })

  it('runs headless by default, because a node usually has no display', async () => {
    const { args } = await run({ command: 'open', args: ['https://example.com'] })
    expect(args).not.toContain('--headed')
  })

  it('shows a window when the operator configured one', async () => {
    const { args } = await run({ command: 'open', args: ['https://example.com'] }, { headed: true })
    expect(args).toContain('--headed')
  })

  it('lets a per-call flag override the configured default, rather than passing it twice', async () => {
    const { args } = await run({ command: 'open', args: ['https://example.com', '--headed', 'false'] }, { headed: true })
    expect(args.filter(argument => argument === '--headed')).toHaveLength(1)
    expect(args).toEqual(['open', 'https://example.com', '--headed', 'false', '--json'])
  })

  it('passes a session through as a flag, keeping browser state isolated per caller', async () => {
    const { args } = await run({ command: 'open', args: ['https://example.com'], session: 'tester' })
    expect(args.slice(-2)).toEqual(['--session', 'tester'])
  })
})

describe('how the browser pack reports trouble', () => {
  it('surfaces an error written to stdout, which is where agent-browser puts it', async () => {
    await expect(run({ command: 'open', args: ['x'] }, {}, stubResult({ exitCode: 1, stdout: 'chrome is not installed' })))
      .rejects.toThrow('agent-browser failed (exit 1): chrome is not installed')
  })

  it('names the exit code even when the command said nothing at all', async () => {
    await expect(run({ command: 'doctor', args: [] }, {}, stubResult({ exitCode: 2, stdout: '' })))
      .rejects.toThrow('agent-browser failed (exit 2) with no output')
  })

  it('reports why the pack is missing rather than pretending it is installed', () => {
    const pack = createBrowserPack({
      cwd: '/work',
      agentBrowserCommand: 'agent-browser',
      headed: false,
      available: false,
      runProcess: async () => stubResult(),
    })
    expect(pack.unavailableReason).toBe('agent-browser is not installed on this node')
  })
})
