import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { QUICK_TIMEOUT_MS } from '../common/adapters/judge/typesafe.js'
import { JUDGE_TIMEOUT_MS } from '../common/adapters/judge/verdict.js'
import { SOCKET_TIMEOUT_MS } from '../common/adapters/package-scan/socket.js'
import { FLOOR_WARNING } from '../common/domain/approval-instruction.js'
import { isInterpreter } from '../common/domain/command-forms.js'
import { CODE_REFUSALS, SCRIPT_TEXT_REFUSAL } from '../common/services/judge/code-reader.js'
import { SHELL_TEXT_REFUSAL } from '../common/services/judge/shell-statement.js'

// What the decision AI's pages say of standard scripts (D91, addendum 2, defect 5): bun is an interpreter, so `bun run`
// asks on its own and `bun run *` applies; no page may call it an ordinary command.

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs')
const pages = readdirSync(DOCS).filter(name => name.endsWith('.md')).map(name => ({ name, text: readFileSync(join(DOCS, name), 'utf8').replace(/\s+/g, ' ') }))

describe('the time budgets', () => {
  it('are 20 s for the thorough stage, 5 s an attempt for the quick stage, and 10 s for Socket, as judge-02.md quotes them', () => {
    expect([JUDGE_TIMEOUT_MS, QUICK_TIMEOUT_MS, SOCKET_TIMEOUT_MS]).toEqual([20_000, 5_000, 10_000])
    const page = pages.find(item => item.name === 'judge-02.md')!.text
    expect(page).toContain('20 seconds for the thorough model')
    expect(page).toContain('5 seconds an attempt for Jev')
    expect(page).toContain('a timeout of 10 seconds')
  })
})

describe('bun run on the pages', () => {
  it('is never called an ordinary command, or no interpreter', () => {
    expect(isInterpreter('bun')).toBe(true)
    const wrong = pages.filter(page => /`bun run`[^.]*(?:ordinary commands?|not interpreters?)/.test(page.text)).map(page => page.name)
    expect(wrong).toEqual([])
  })

  it('is named among the interpreter invocations where the standard scripts are listed', () => {
    const judge = pages.find(page => page.name === 'judge.md')!
    expect(judge.text).toMatch(/`bun run`, `npx`, `pnpx`, and `bunx` are interpreter invocations/)
  })
})

describe('the reasons a reading refuses with', () => {
  it('are quoted on judge-03.md as an approver reads them (fix brief 4; fix brief 6, B9; fix brief 7, D7)', () => {
    const page = pages.find(item => item.name === 'judge-03.md')!.text
    for (const reason of [SHELL_TEXT_REFUSAL, CODE_REFUSALS.unknownOption, CODE_REFUSALS.subcommand, CODE_REFUSALS.interactive, CODE_REFUSALS.discoveringModule, CODE_REFUSALS.stdin, CODE_REFUSALS.unmodelledImport, CODE_REFUSALS.compiledPython, CODE_REFUSALS.config, CODE_REFUSALS.localInterpreter, CODE_REFUSALS.programName, CODE_REFUSALS.splitWords, CODE_REFUSALS.runnerSource, SCRIPT_TEXT_REFUSAL]) {
      expect(page, reason).toContain(`"${reason}"`)
    }
  })

  it('quote the floor\'s warning line where judge.md and judge-03.md describe a floor ask (addendum 3 R2 and R4)', () => {
    for (const name of ['judge.md', 'judge-03.md']) expect(pages.find(item => item.name === name)!.text, name).toContain(`"${FLOOR_WARNING}"`)
  })
})
