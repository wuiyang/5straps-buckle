import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../common/runtime/config.js'
import { createConsoleWriter, type ConsoleWriter } from '../common/runtime/console.js'
import { configureRootLogger, flushLogs, logger } from '../common/runtime/log.js'
import type { ServeHttpInput } from '../server/serve.js'
import { serveHttp } from '../server/serve.js'
import { consoleRoster, rosterLines } from '../server/roster.js'

// The CLI display slice, C3: buckle serve's log lines, workspace list, and approval questions share one writer, which
// owns the date separator, keeps them in order, and draws a line logged during a question above its prompt.

afterEach(() => { vi.unstubAllEnvs() })

function screen(isTTY: boolean) {
  const output = new PassThrough()
  if (isTTY) Object.assign(output, { isTTY: true, columns: 80, rows: 24 })
  let shown = ''
  output.on('data', (chunk: Buffer) => { shown += chunk.toString('utf8') })
  return { output, shown: () => shown }
}

/**
 * A readline on `output` with TERM pinned to a capable terminal: Node's readline reads TERM when it is created, and
 * under TERM=dumb it redraws a prompt without the text typed after it, so a row would pass or fail by the caller's shell.
 */
function interfaceOn(input: PassThrough, output: PassThrough) {
  vi.stubEnv('TERM', 'xterm-256color')
  return createInterface({ input, output })
}

describe('the console writer', () => {
  it('writes the date separator lazily: before the first line, and again whenever a line\'s local date changes', () => {
    vi.stubEnv('TZ', 'Asia/Kuala_Lumpur')
    const terminal = screen(false)
    const writer = createConsoleWriter({ output: terminal.output, dates: true })
    expect(terminal.shown()).toBe('')
    writer.write(['23:59:58 [info] late'], new Date('2026-10-21T15:59:58Z'))
    writer.write(['23:59:59 [info] still the 21st', '  a second line'], new Date('2026-10-21T15:59:59Z'))
    writer.write(['00:00:00 [info] the next day'], new Date('2026-10-21T16:00:00Z'))
    expect(terminal.shown()).toBe('--- 2026-10-21 ---\n23:59:58 [info] late\n23:59:59 [info] still the 21st\n  a second line\n--- 2026-10-22 ---\n00:00:00 [info] the next day\n')
  })

  it('writes no separator where it keeps no dates, as for a one-shot command', () => {
    const terminal = screen(false)
    createConsoleWriter({ output: terminal.output, dates: false }).write(['14:22:00 [warn] once'], new Date())
    expect(terminal.shown()).toBe('14:22:00 [warn] once\n')
  })

  it('writes a block after every log line logged before it, and blocks in the order they came', async () => {
    const terminal = screen(false)
    const at = new Date()
    const queued = ['14:22:00 [info] logged before the block']
    // The logger's queue, as flushLogs empties it: slowly, through the same writer.
    const writer: ConsoleWriter = createConsoleWriter({
      output: terminal.output,
      dates: false,
      flush: async () => {
        await new Promise(resolve => setTimeout(resolve, 20))
        for (const line of queued.splice(0)) writer.write([line], at)
      },
    })
    await Promise.all([writer.block(['first block'], at), writer.block(['second block'], at)])
    expect(terminal.shown()).toBe('14:22:00 [info] logged before the block\nfirst block\nsecond block\n')
  })

  it('draws a line written during a question on the prompt\'s row, then the prompt and the typed text again below it', async () => {
    const terminal = screen(true)
    const input = new PassThrough()
    const readline = interfaceOn(input, terminal.output)
    const writer = createConsoleWriter({ output: terminal.output, dates: false })
    try {
      readline.question('[site] Your choice: ', () => {})
      input.write('2')
      await vi.waitFor(() => expect(terminal.shown()).toMatch(/Your choice: \S*2$/))
      const release = writer.asking(readline)
      const before = terminal.shown().length
      writer.write(['22:22:05 [info] /mcp request completed (3ms)'], new Date())
      const drawn = terminal.shown().slice(before)
      expect(drawn.startsWith('\u001b[2K\u001b[1G22:22:05 [info] /mcp request completed (3ms)\n')).toBe(true)
      expect(drawn).toContain('[site] Your choice: 2')
      release()
      const after = terminal.shown().length
      writer.write(['22:22:06 [info] after the question'], new Date())
      expect(terminal.shown().slice(after)).toBe('22:22:06 [info] after the question\n')
    } finally {
      readline.close()
    }
  })

  // Fix brief 2, L4: the contracts the logger and the next block lean on, which no earlier test read.
  describe('what the logger and the next block rely on', () => {
    // The human sink awaits a drain whenever write() says false, and a held write emits none.
    it('accepts a write while an ending is held, and writes it, with the rest, when the question is released', () => {
      const terminal = screen(true)
      const readline = interfaceOn(new PassThrough(), terminal.output)
      const writer = createConsoleWriter({ output: terminal.output, dates: false })
      try {
        const release = writer.asking(readline)
        release.hold()
        expect(writer.write(['22:22:05 [info] first'], new Date())).toBe(true)
        expect(writer.write(['22:22:06 [info] second'], new Date())).toBe(true)
        expect(terminal.shown()).toBe('')
        release()
        expect(terminal.shown()).toBe('22:22:05 [info] first\n22:22:06 [info] second\n')
      } finally {
        readline.close()
      }
    })

    it('does not stall the logger while an ending is held: a flush still returns, and returns again after the release', async () => {
      const terminal = screen(true)
      const readline = interfaceOn(new PassThrough(), terminal.output)
      const writer = createConsoleWriter({ output: terminal.output, dates: false })
      configureRootLogger({}, { format: 'human', console: writer })
      const flushed = async () => {
        let timer: NodeJS.Timeout | undefined
        try {
          return await Promise.race([flushLogs().then(() => 'flushed'), new Promise<string>((resolve) => { timer = setTimeout(() => resolve('stalled'), 1_000) })])
        } finally {
          clearTimeout(timer)
        }
      }
      try {
        const release = writer.asking(readline)
        release.hold()
        logger.info('logged while held')
        expect(await flushed()).toBe('flushed')
        expect(terminal.shown()).toBe('')
        release()
        expect(terminal.shown()).toMatch(/\[info\] logged while held\n$/)
        logger.info('logged after the release')
        expect(await flushed()).toBe('flushed')
        expect(terminal.shown()).toMatch(/\[info\] logged after the release\n$/)
      } finally {
        readline.close()
        configureRootLogger({})
      }
    })

    it('writes a block whose flush fails, and the blocks after it', async () => {
      const terminal = screen(false)
      let flushes = 0
      const writer = createConsoleWriter({ output: terminal.output, dates: false, flush: async () => { flushes += 1; if (flushes === 1) throw new Error('flush failed') } })
      await writer.block(['first block'], new Date())
      await writer.block(['second block'], new Date())
      expect(terminal.shown()).toBe('first block\nsecond block\n')
      expect(flushes).toBe(2)
    })

    it('reads the logger\'s queue before a block even when the block before it failed to write', async () => {
      const terminal = screen(true)
      const readline = interfaceOn(new PassThrough(), terminal.output)
      const flush = vi.fn(async () => {})
      const writer = createConsoleWriter({ output: terminal.output, dates: false, flush })
      readline.close()
      // A question that is still registered when its readline is closed: drawing the prompt again throws.
      const release = writer.asking(readline)
      await expect(writer.block(['lost block'], new Date())).rejects.toThrow()
      release()
      await writer.block(['next block'], new Date())
      expect(flush).toHaveBeenCalledTimes(2)
      expect(terminal.shown()).toMatch(/next block\n$/)
    })
  })

  // Fix brief 2, L2: a question whose block is shown and whose prompt is not has nothing on screen to draw again.
  describe('a question with no prompt yet', () => {
    it('writes lines at once until the question ends, then keeps the lines that follow and writes them in one go as it is released', () => {
      const terminal = screen(true)
      const writer = createConsoleWriter({ output: terminal.output, dates: false })
      const write = vi.spyOn(terminal.output, 'write')
      const question = writer.holding()
      writer.write(['before'], new Date())
      expect(terminal.shown()).toBe('before\n')
      question.hold()
      expect(writer.write(['first'], new Date())).toBe(true)
      expect(writer.write(['second'], new Date())).toBe(true)
      expect(terminal.shown()).toBe('before\n')
      write.mockClear()
      question()
      expect(write.mock.calls).toEqual([['first\nsecond\n']])
      expect(terminal.shown()).toBe('before\nfirst\nsecond\n')
    })

    it('holds nothing once released, and writes what it kept only once', () => {
      const terminal = screen(true)
      const writer = createConsoleWriter({ output: terminal.output, dates: false })
      const ended = writer.holding()
      ended()
      ended.hold()
      writer.write(['after'], new Date())
      expect(terminal.shown()).toBe('after\n')
      const held = writer.holding()
      held.hold()
      writer.write(['kept'], new Date())
      held()
      held()
      expect(terminal.shown()).toBe('after\nkept\n')
    })
  })

  it('writes plainly where its output is no terminal: no cursor control, and no prompt drawn again', async () => {
    const terminal = screen(false)
    const input = new PassThrough()
    const readline = interfaceOn(input, terminal.output)
    const writer = createConsoleWriter({ output: terminal.output, dates: false })
    try {
      readline.question('[site] Your choice: ', () => {})
      const release = writer.asking(readline)
      writer.write(['22:22:05 [info] plain'], new Date())
      release()
      expect(terminal.shown()).toBe('[site] Your choice: 22:22:05 [info] plain\n')
    } finally {
      readline.close()
    }
  })
})

describe('the workspace list on a person\'s console', () => {
  it('stamps its first line with the time and an [info] tag, and keeps the rest as listed', () => {
    vi.stubEnv('TZ', 'UTC')
    expect(rosterLines('Workspaces changed.\nServing 1 workspace:\n  Site one\n', new Date('2026-10-21T14:22:00Z'))).toEqual(['14:22:00 [info] Workspaces changed.', 'Serving 1 workspace:', '  Site one'])
  })

  it('goes through the writer, after the log lines before it', async () => {
    vi.stubEnv('TZ', 'UTC')
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-10-21T14:22:00Z'))
      const terminal = screen(false)
      const writer: ConsoleWriter = createConsoleWriter({ output: terminal.output, dates: true, flush: async () => { writer.write(['14:22:00 [info] 5straps Buckle listening'], new Date()) } })
      consoleRoster(writer)('Serving 1 workspace:\n  site\n')
      await vi.waitFor(() => expect(terminal.shown()).toBe('--- 2026-10-21 ---\n14:22:00 [info] 5straps Buckle listening\n14:22:00 [info] Serving 1 workspace:\n  site\n'))
    } finally {
      vi.useRealTimers()
    }
  })

  // Fix brief 1, H6: buckle serve lists its workspaces through the console it is handed, and on stderr as listed without one.
  describe('from buckle serve', () => {
    const none = 'No workspace is online: buckle workspace init serves a folder, and buckle workspace enable <id> serves one again.'

    async function served(extra: Partial<ServeHttpInput>): Promise<void> {
      const state = mkdtempSync(join(tmpdir(), 'buckle-console-serve-'))
      const config = { ...loadConfig({ BUCKLE_STATE_DIR: state, BUCKLE_SANDBOX: 'none' }), host: '127.0.0.1', port: 0 }
      const closers: Array<() => unknown> = []
      const workspaces = { list: () => [], closeUnserved: async () => {} }
      const common = { owner: { onClose: (...args: unknown[]) => { closers.push(args.at(-1) as () => unknown) } }, start: async () => {}, services: { getWorkspaces: async () => workspaces } }
      try {
        await serveHttp({ config, common: common as never, logger: { info: vi.fn(), warn: vi.fn() } as never, server: { middleware: (_request: unknown, response: { end(): void }) => response.end() } as never, ...extra })
      } finally {
        for (const close of closers.reverse()) await close()
        rmSync(state, { recursive: true, force: true })
      }
    }

    it('goes through the console it is handed, its first line stamped with the time and [info]', async () => {
      vi.stubEnv('TZ', 'UTC')
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-21T14:22:00Z'))
      const terminal = screen(false)
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      try {
        await served({ console: createConsoleWriter({ output: terminal.output, dates: false }) })
        await vi.waitFor(() => expect(terminal.shown()).toBe(`14:22:00 [info] ${none}\n`))
        expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join('')).not.toContain(none)
      } finally {
        stderr.mockRestore()
        vi.useRealTimers()
      }
    })

    it('goes to stderr as listed where it is handed no console', async () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      try {
        await served({})
        expect(stderr.mock.calls.map(([chunk]) => String(chunk))).toContain(`${none}\n`)
      } finally {
        stderr.mockRestore()
      }
    })
  })
})
