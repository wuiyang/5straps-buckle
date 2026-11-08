import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { UNREAD_CODE } from '../cli/dangerously-allow-words.js'
import { SCRIPT_FILE_REASON } from '../common/domain/permission/rules/destructive-command-rule.js'

// The pages that say a script file run directly asks, in the words Buckle prints, and that a package
// script does not.
describe('the pages that say so', () => {
  const page = (name: string) => readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'user', name), 'utf8').replace(/\s+/g, ' ')

  it('names the ask as the floor gives it, what safe keeps, and that a package script does not ask', () => {
    expect(page('caveats/troubleshooting-02.md')).toContain(SCRIPT_FILE_REASON)
    expect(page('how-to/approvals-04.md')).toContain(UNREAD_CODE)
    const scripts = page('how-to/policy-03.md')
    expect(scripts).toContain('## Script files')
    expect(scripts).toContain('a `package.json` or `Makefile` the agent edits can still run anything, malware included')
    expect(page('caveats/known-limits.md')).toContain('a `package.json` the agent edits can run anything')
  })
})
