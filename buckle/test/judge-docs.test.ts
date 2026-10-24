import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { QUICK_TIMEOUT_MS } from '../common/adapters/judge/typesafe.js'
import { JUDGE_TIMEOUT_MS } from '../common/adapters/judge/verdict.js'
import { SOCKET_TIMEOUT_MS } from '../common/adapters/package-scan/socket.js'
import { FLOOR_WARNING } from '../common/domain/approval-instruction.js'
import { isInterpreter, READ_LIMITS } from '../common/domain/command-forms.js'
import { CODE_CHANGED_REASON } from '../common/domain/permission/judged.js'
import { NPM_CODE_OPTION } from '../common/services/judge/call-forms.js'
import { CODE_REFUSALS, SCRIPT_TEXT_REFUSAL } from '../common/services/judge/code-reader.js'
import { SHELL_TEXT_REFUSAL } from '../common/services/judge/shell-statement.js'
import { BUILT_IN_SETTINGS } from '../common/services/workspaces/workspace-settings.js'
import { CREDENTIAL_HIDDEN } from '../common/services/workspaces/workspace-runtime.js'
import { JUDGE_MODES, JUDGE_PROVIDERS } from '../common/types/ports/judge.js'
import { QUICK_JUDGE_PROVIDERS, QUICK_JUDGE_SCOPES } from '../common/types/ports/quick-judge.js'

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
  it('are quoted on judge-05.md as an approver reads them (fix brief 4; fix brief 6, B9; fix brief 7, D7; fix brief 8, D8; fix brief 9, D9)', () => {
    const page = pages.find(item => item.name === 'judge-05.md')!.text
    for (const reason of [SHELL_TEXT_REFUSAL, CODE_REFUSALS.unknownOption, CODE_REFUSALS.subcommand, CODE_REFUSALS.interactive, CODE_REFUSALS.discoveringModule, CODE_REFUSALS.stdin, CODE_REFUSALS.unmodelledImport, CODE_REFUSALS.compiledPython, CODE_REFUSALS.config, CODE_REFUSALS.localInterpreter, CODE_REFUSALS.programName, CODE_REFUSALS.splitWords, CODE_REFUSALS.runnerSource, CODE_REFUSALS.xargsWords, CODE_REFUSALS.dotdotAfterLink, CODE_REFUSALS.outsideCopy, NPM_CODE_OPTION, SCRIPT_TEXT_REFUSAL, READ_LIMITS.qualifier]) {
      expect(page, reason).toContain(`"${reason}"`)
    }
  })

  it('quote the on-request refusal of a call whose kept arguments hide a credential, and the reason a changed file sends a pass to a person (fix brief 9, D9)', () => {
    expect(pages.find(item => item.name === 'judge-03.md')!.text).toContain(`"${CREDENTIAL_HIDDEN}"`)
    expect(pages.find(item => item.name === 'judge.md')!.text).toContain(`"${CODE_CHANGED_REASON}"`)
  })

  it('quote the floor\'s warning line where judge.md and judge-03.md describe a floor ask (addendum 3 R2 and R4)', () => {
    for (const name of ['judge.md', 'judge-03.md']) expect(pages.find(item => item.name === name)!.text, name).toContain(`"${FLOOR_WARNING}"`)
  })
})

// The lines round 9's docs commit (fix brief 9, D9), the F6 follow-up, and the F4 residue added are pinned by their exact
// sentences, each against the page that holds it; the quoted reasons above pin the reasons alone (D91 follow-up F7). The
// page text has its whitespace collapsed, so a sentence wrapped in the source is one line here.

const defaults = BUILT_IN_SETTINGS.approval
const code = (value: string) => `\`${value}\``
const either = (values: readonly string[]) => values.length <= 2 ? values.map(code).join(' or ') : `${values.slice(0, -1).map(code).join(', ')}, or ${code(values.at(-1)!)}`

interface PinnedLine { page: string; what: string; text: string }

const PINNED: PinnedLine[] = [
  { page: 'known-limits-07.md', what: 'the pre and post hooks bullet', text: '- npm, pnpm, and yarn classic also run `pre<name>` and `post<name>` beside the named script unless configured off, and the stages see only the named script\'s text; bun is unconfirmed.' },
  { page: 'known-limits-07.md', what: 'the B30 line on a runner package that is not URL-safe', text: 'and a scope or name that is not URL-safe, which npm reads as a folder (`npx @scope/x#y`).' },
  { page: 'judge-05.md', what: 'the B30 item in the list of what no stage is shown', text: 'or by a scope or name that is not URL-safe (`npx @scope/x#y`);' },
  { page: 'judge-05.md', what: 'the B30 clause of the runner reason', text: 'a version part naming a folder (`npx eslint@.`) and a scope or name that is not URL-safe;' },
  { page: 'workspaces-02.md', what: 'the approval.judge row', text: `| ${code('approval.judge')} | the [decision AI](judge.md), an optional model check: ${either(JUDGE_MODES)} | ${code(defaults.judge)} |` },
  { page: 'workspaces-02.md', what: 'the approval.judgeProvider row', text: `| ${code('approval.judgeProvider')} | the thorough model's provider: ${either(JUDGE_PROVIDERS)} | ${code(defaults.judgeProvider)} |` },
  { page: 'workspaces-02.md', what: 'the approval.judgeModel row', text: `| ${code('approval.judgeModel')} | the thorough model's name, as your AI gateway serves it | ${code(defaults.judgeModel)} |` },
  { page: 'workspaces-02.md', what: 'the approval.judgeStandardScripts row', text: `| ${code('approval.judgeStandardScripts')} | commands rated on their command line alone, globs separated by ${code(';;')} | [the standard scripts](judge.md#standard-development-scripts) |` },
  { page: 'workspaces-02.md', what: 'the approval.quickJudge row', text: `| ${code('approval.quickJudge')} | what Jev, TypeSafe AI's quick decision model, rates: ${either(QUICK_JUDGE_SCOPES)} | ${code(defaults.quickJudge)} |` },
  { page: 'workspaces-02.md', what: 'the approval.quickJudgeProvider row', text: `| ${code('approval.quickJudgeProvider')} | Jev's provider: ${either(QUICK_JUDGE_PROVIDERS)} | ${code(defaults.quickJudgeProvider)} |` },
  { page: 'workspaces-02.md', what: 'the approval.quickJudgeModel row', text: `| ${code('approval.quickJudgeModel')} | Jev's model name | ${code(defaults.quickJudgeModel)} |` },
  { page: 'workspaces-03.md', what: 'the node aliases of the thorough stage\'s settings', text: '| `approval-judge`, `approval-judge-provider`, `approval-judge-model`, and `approval-judge-standard-scripts` (`BUCKLE_APPROVAL_JUDGE*`) | `approval.judge`, `approval.judgeProvider`, `approval.judgeModel`, and `approval.judgeStandardScripts` |' },
  { page: 'workspaces-03.md', what: 'the node aliases of Jev\'s settings', text: '| `approval-quick-judge` and `approval-quick-judge-model` (`BUCKLE_APPROVAL_QUICK_JUDGE*`) | `approval.quickJudge` and `approval.quickJudgeModel`; `approval.quickJudgeProvider` has no node default |' },
  { page: 'judge-03.md', what: 'the F6 line that an ask\'s line offers no approval where only Jev holds a key', text: 'Where only Jev holds a key, an ask\'s line offers no approval on any route that shows it.' },
  { page: 'judge.md', what: 'the F4 residue line that no stage rates code a mount holds under shell isolation', text: 'Under shell isolation the program runs in a copy of the workspace folder while each mount stays live, so no stage rates an ask whose code is read from a mount: it goes to a person.' },
  { page: 'known-limits-07.md', what: 'the F4 residue clause on a write from another workspace through a shared mount', text: '(a process still running from an earlier call, or another workspace writing through a shared mount) can land after that check.' },
]

/** The pins whose sentence its page does not hold exactly once. */
function notHeld(held: ReadonlyArray<{ name: string; text: string }>, lines: readonly PinnedLine[]): PinnedLine[] {
  return lines.filter(line => held.find(page => page.name === line.page)?.text.split(line.text).length !== 2)
}

describe('the lines round 9 added to the pages (fix brief 9, D9; follow-up F7)', () => {
  it.each(PINNED)('$page holds $what, word for word, once', (line) => {
    expect(notHeld(pages, [line])).toEqual([])
  })

  // The check itself, on a page of its own: it reports a sentence that is altered, said twice, or on no page.
  it.each(PINNED)('reports $what where its page alters it, says it twice, or is not there', (line) => {
    const page = (text: string) => [{ name: line.page, text }]
    expect(notHeld(page(`before ${line.text} after`), [line])).toEqual([])
    expect(notHeld(page(`before ${line.text.slice(0, -2)}XX after`), [line])).toEqual([line])
    expect(notHeld(page(`${line.text} ${line.text}`), [line])).toEqual([line])
    expect(notHeld([], [line])).toEqual([line])
  })

  // The helper that writes a settings row's list of values follows the house rule: two values take `or` and no comma, three
  // or more take the Oxford comma (workspaces-02.md writes the two-value `packs.shell` row as `on` or `off`).
  it('writes a list of one value as it is, two with `or` and no comma, and more with the Oxford comma', () => {
    expect(either(['a'])).toBe('`a`')
    expect(either(['a', 'b'])).toBe('`a` or `b`')
    expect(either(['a', 'b', 'c'])).toBe('`a`, `b`, or `c`')
  })

  it('has a pinned row for each of the node\'s approval settings, in the order the page lists them', () => {
    const keys = ['judge', 'judgeProvider', 'judgeModel', 'judgeStandardScripts', 'quickJudge', 'quickJudgeProvider', 'quickJudgeModel']
    expect(Object.keys(defaults)).toEqual(keys)
    expect(PINNED.filter(line => line.page === 'workspaces-02.md').map(line => line.what)).toEqual(keys.map(key => `the approval.${key} row`))
  })
})
