import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isInterpreter } from '../common/domain/command-forms.js'

// What the decision AI's pages say of standard scripts (D91, addendum 2, defect 5): bun is an interpreter, so `bun run`
// asks on its own and `bun run *` applies; no page may call it an ordinary command.

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs')
const pages = readdirSync(DOCS).filter(name => name.endsWith('.md')).map(name => ({ name, text: readFileSync(join(DOCS, name), 'utf8').replace(/\s+/g, ' ') }))

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
