import { clearLine, cursorTo, type Interface } from 'node:readline'
import type { Writable } from 'node:stream'
import { createDateSeparators } from './log-render.js'

/**
 * The one writer of the terminal a person reads (the CLI display slice, C3). `buckle serve` hands its log lines, its
 * workspace list, and its approval questions to it, so they reach the terminal in order, under one date separator, and
 * a line logged while a question is open lands above that question's prompt instead of on it. It never holds a line
 * back: the logger waits on every write, and a sink that waited for a question to close would stall it and drop lines.
 */
export interface ConsoleWriter {
  readonly output: Writable
  /**
   * Lines a person reads, the first already stamped by the caller, with a date separator first where `at` falls on
   * another local date than the last line did. False where the output asks the caller to wait for a drain.
   */
  write(lines: readonly string[], at: Date): boolean
  /** A block written whole, in turn: after every log line logged before it, and after every earlier block. */
  block(lines: readonly string[], at: Date): Promise<void>
  /** A question's prompt is on screen from now until the returned function runs. */
  asking(question: Interface): () => void
}

/**
 * `dates`: whether the separator is written (a serve's console; a one-shot command prints time-stamped lines alone).
 * `flush`: what writes every log line logged so far, called before each block.
 */
export function createConsoleWriter(input: { output: Writable; dates: boolean; flush?: () => Promise<void> }): ConsoleWriter {
  const { output } = input
  // Cursor control only where the output is a terminal: anywhere else the escapes would land in the text.
  const terminal = (output as { isTTY?: boolean }).isTTY === true
  const separators = createDateSeparators()
  let question: Interface | undefined
  let turn: Promise<void> = Promise.resolve()

  function write(lines: readonly string[], at: Date): boolean {
    const text = [...(input.dates ? separators(at) : []), ...lines].map(line => `${line}\n`).join('')
    if (question === undefined || !terminal) return output.write(text)
    // Readline never draws its prompt again after another write: clear the prompt's row, write there, then have it
    // draw the prompt and the typed text on the row below. The prompt is kept to one row, so one row is cleared.
    clearLine(output, 0)
    cursorTo(output, 0)
    const written = output.write(text)
    question.prompt(true)
    return written
  }

  return {
    output,
    write,
    block(lines, at) {
      // A flush that fails still lets the block through: the lines before it are the logger's to report.
      const written = turn.then(() => input.flush?.()).catch(() => undefined).then(() => { write(lines, at) })
      turn = written.catch(() => undefined)
      return written
    },
    asking(next) {
      question = next
      return () => {
        if (question === next) question = undefined
      }
    },
  }
}
