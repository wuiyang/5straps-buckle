import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
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
