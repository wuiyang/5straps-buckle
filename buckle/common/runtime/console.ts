import { clearLine, cursorTo, type Interface } from 'node:readline'
import type { Writable } from 'node:stream'
import { createDateSeparators } from './log-render.js'

/**
 * The one writer of the terminal a person reads (the CLI display slice, C3). `buckle serve` hands its log lines, its
 * workspace list, and its approval questions to it, so they reach the terminal in order, under one date separator, and
 * a line logged while a question is open lands above that question's prompt instead of on it. It never makes the logger
 * wait for a question: the logger waits on every write, and a sink that waited for a question to close would stall it
 * and drop lines. Only as a question ends does it keep the lines it is handed, until the ending is on the prompt's row.
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
  /** A question's prompt is on screen from now until it is released. */
  asking(question: Interface): PromptRelease
  /**
   * A question whose block is on screen and whose prompt is not yet: nothing to draw again, so a line logged meanwhile is
   * written at once, and only `hold()`, as the question ends, makes the lines that follow wait (fix brief 2, L2).
   */
  holding(): PromptRelease
}

/**
 * Ends a question's hold on the writer; idempotent. `hold()` first, as the question ends: the prompt is gone, and every
 * line written from then on waits, accepted at once so the logger never waits, until the release writes them in one go
 * below the ending the question writes on its row (fix brief 1, H1). One hold at a time.
 */
export interface PromptRelease {
  (): void
  hold(): void
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
  let held: string[] | undefined
  let turn: Promise<void> = Promise.resolve()

  /** Every write waits from now until the returned release writes them in one go; the release is idempotent. */
  function startHolding(): () => void {
    const mine: string[] = []
    held = mine
    return () => {
      if (held !== mine) return
      held = undefined
      const text = mine.join('')
      if (text !== '') output.write(text)
    }
  }

  function write(lines: readonly string[], at: Date): boolean {
    const text = [...(input.dates ? separators(at) : []), ...lines].map(line => `${line}\n`).join('')
    if (held !== undefined) {
      held.push(text)
      return true
    }
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
      let stopHolding: (() => void) | undefined
      const release = () => {
        if (question === next) question = undefined
        stopHolding?.()
      }
      return Object.assign(release, {
        hold() {
          if (question !== next) return
          question = undefined
          stopHolding = startHolding()
        },
      })
    },
    holding() {
      let released = false
      let stopHolding: (() => void) | undefined
      return Object.assign(() => {
        released = true
        stopHolding?.()
      }, {
        hold() {
          if (released || stopHolding !== undefined) return
          stopHolding = startHolding()
        },
      })
    },
  }
}
