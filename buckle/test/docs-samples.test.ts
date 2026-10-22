import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { approvalBlock, type ApprovalQuestion } from '../cli/terminal-consumer.js'
import { actionPhrase } from '../common/domain/action-phrase.js'
import { describeApprovalRequest } from '../common/domain/approval-instruction.js'

// Output a page shows a reader, held to what the code prints, so a page cannot drift from it again (fix brief 4, finding 43).

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..')
const PAGES = ['docs/first-run.md', 'buckle/skills/buckle/SKILL.md']

describe('the approval message a page shows', () => {
  const lines = describeApprovalRequest({
    request: { token: '3f6c1a2b-0000-4000-8000-000000000000', rule: 'write_scope', subject: '/home/you/code/my-project', reason: 'Writing to /workspace is not yet approved', tool: 'fs_write', offeredScopes: ['once', 'session'], expiresAt: new Date(Date.now() + 600_000).toISOString() },
    workspaceId: 'a9f9e5a2-52ac-5720-bc81-771fd12913c6', workspaceName: 'my-project',
  })
  const named = (start: string) => lines.find(line => line.startsWith(start))!

  it.each(PAGES)('names the workspace once, and the commands that review and answer it, in %s', (page) => {
    const text = readFileSync(join(PACKAGE, '..', page), 'utf8')
    expect(named('waiting on')).toBe('waiting on workspace my-project')
    expect(text).toContain(`  ${named('waiting on')}\n`)
    expect(text).toContain(`  ${named('see the whole action with')}\n`)
    expect(text).toContain(`  then approve with: buckle approve `)
    expect(text).toContain(`--scope session --workspace my-project (it shows the action again and asks to confirm)`)
  })
})

// The CLI display slice, C8: the serve terminal's question as the pages quote it, held to what the code prints.
describe('the terminal question a page shows', () => {
  const page = (name: string) => readFileSync(join(PACKAGE, '..', name), 'utf8')
  const question = (tool: string, rule: ApprovalQuestion['rule'], offeredScopes: ApprovalQuestion['offeredScopes']): ApprovalQuestion => ({
    tool, rule, offeredScopes, subject: '/home/you/code/my-project', reason: 'Writing to /workspace is not yet approved', expiresAt: new Date(Date.now() + 600_000).toISOString(),
    workspaceId: 'a9f9e5a2-52ac-5720-bc81-771fd12913c6', workspaceName: 'my-project', call: { arguments: {}, cwd: '/workspace', description: null },
  })

  it('quotes a write\'s choices and its prompt row in docs/first-run.md', () => {
    expect(page('docs/first-run.md')).toContain(`${approvalBlock(question('fs_write', 'write_scope', ['once', 'session', 'always']), new Date()).at(-1)}\n[my-project] Your choice:`)
  })

  it('quotes the head line and the destructive floor\'s choices in docs/approvals-02.md', () => {
    const block = approvalBlock(question('shell_exec', 'destructive_command', ['once', 'session']), new Date())
    expect(page('docs/approvals-02.md')).toContain(` [approval] [my-project] action pending approval: ${actionPhrase('shell_exec')}\n`)
    expect(page('docs/approvals-02.md')).toContain(`${block.at(-1)}\n[my-project] Your choice: 2\n`)
  })
})
