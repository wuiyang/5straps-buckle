import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConsoleWriter, type ConsoleWriter } from '../common/runtime/console.js'
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
    const readline = createInterface({ input, output: terminal.output })
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

  it('writes plainly where its output is no terminal: no cursor control, and no prompt drawn again', async () => {
    const terminal = screen(false)
    const input = new PassThrough()
    const readline = createInterface({ input, output: terminal.output })
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
})
