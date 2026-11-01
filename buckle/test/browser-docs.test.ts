import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { describeCounts } from '../cli/browser.js'
import { loadPackSkill } from '../common/services/packs/pack-skill.js'

// Slice F4, item 8: the browser pages say what a close, a restart, and the owner's command end, held to what the code
// prints and does, and the known limits name what Windows still shows.

const REPOSITORY = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const page = (name: string) => readFileSync(join(REPOSITORY, name), 'utf8').replace(/\s+/g, ' ')

describe('the browser sessions page', () => {
  it('says what a close, the idle timeout, a stop, the next start, and the owner\'s command each end', () => {
    const sessions = page('docs/browser-login-02.md')
    for (const event of ['The agent\'s `close`', 'The idle timeout', 'A Buckle process that stops with its close step', 'The next start after a stop that skipped it', '`buckle browser close`']) expect(sessions).toContain(`| ${event}`)
    expect(sessions).toContain('buckle browser close [--workspace <name>]')
    expect(sessions).toContain('so `agent-browser` never starts a browser only to close it')
    expect(sessions).toContain('`--no-startup-window`')
  })

  it('quotes the owner\'s command as it prints its counts', () => {
    expect(page('docs/browser-login-02.md')).toContain(describeCounts({ browsers: 2, closed: 2, held: 1 }, 'site'))
  })

  it('says a hold is its browser\'s, and ends with it, an attached Chrome\'s with the owner\'s command', () => {
    const sessions = page('docs/browser-login-02.md')
    expect(sessions).toContain('A fill from a secret reference is held by the browser it went into, not by the workspace.')
    expect(sessions).toContain('so its hold lasts until `buckle browser close`')
    const masking = page('docs/secrets-02.md')
    expect(masking).toContain('every later call on that browser is masked by it too, in any Buckle process and after a restart')
    expect(masking).toContain('](browser-login-02.md)')
  })

  it('is linked from the pages that choose and run the browser, and from both READMEs', () => {
    for (const name of ['docs/browser-login.md', 'docs/sandbox-and-tools-02.md']) expect(page(name)).toContain('](browser-login-02.md)')
    for (const name of ['README.md', 'buckle/README.md']) expect(page(name)).toContain('docs/browser-login-02.md')
    expect(page('docs/browser-login.md')).not.toContain('by process id alone')
  })

  it('names what Windows still shows among the known limits', () => {
    const limits = page('docs/known-limits-04.md')
    expect(limits).toContain('On Windows, Buckle passes `--no-startup-window`')
    expect(limits).toContain('`agent-browser` before 0.37.1')
  })

  it('tells the agent in its skill what ends the profile folder\'s browser, and that close takes no other arguments', () => {
    const skill = loadPackSkill('browser').content.replace(/\s+/g, ' ')
    expect(skill).toContain('and the shutdown of the Buckle process that used it last')
    expect(skill).toContain('`close` takes no other arguments')
    expect(skill).not.toContain('a Buckle process that stops leaves it running')
  })
})
