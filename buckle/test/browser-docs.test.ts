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
    const sessions = page('docs/user/how-to/browser-login-02.md')
    for (const event of ['The agent\'s `close`', 'The idle timeout', 'A Buckle process that stops with its close step', 'The next start after a stop that skipped it', '`buckle browser close`']) expect(sessions).toContain(`| ${event}`)
    expect(sessions).toContain('buckle browser close [--workspace <name>]')
    expect(sessions).toContain('so `agent-browser` never starts a browser only to close it')
    expect(sessions).toContain('`--no-startup-window`')
  })

  it('quotes the owner\'s command as it prints its counts', () => {
    expect(page('docs/user/how-to/browser-login-02.md')).toContain(describeCounts({ browsers: 2, closed: 2, held: 1 }, 'site'))
  })

  it('says a hold is its browser\'s, and ends with it, an attached Chrome\'s with the owner\'s command', () => {
    const sessions = page('docs/user/how-to/browser-login-02.md')
    expect(sessions).toContain('A fill from a secret reference is held by the browser it went into, not by the workspace.')
    expect(sessions).toContain('so its hold lasts until `buckle browser close`')
    const masking = page('docs/user/how-to/secrets-02.md')
    expect(masking).toContain('every later call on that browser is masked by it too, in any Buckle process and after a restart')
    expect(masking).toContain('](browser-login-02.md)')
  })

  it('is linked from the pages that choose and run the browser, and from both READMEs', () => {
    for (const name of ['docs/user/how-to/browser-login.md', 'docs/user/how-to/sandbox-and-tools-02.md']) expect(page(name)).toContain('](browser-login-02.md)')
    for (const name of ['README.md', 'buckle/README.md']) expect(page(name)).toContain('docs/user/how-to/browser-login-02.md')
    expect(page('docs/user/how-to/browser-login.md')).not.toContain('by process id alone')
  })

  // Codex review L1 to L7: what the owner's command leaves, which browser a hold masks, and who shares a profile folder.
  it('says what the owner\'s command leaves and why it exits 1, which browser a hold masks, and that a session starts once', () => {
    const sessions = page('docs/user/how-to/browser-login-02.md')
    expect(sessions).toContain('It exits 1, saying what stays, where it could not end everything:')
    expect(sessions).toContain('A browser whose close failed stays recorded with its hold')
    expect(sessions).toContain('A browser a call still runs on closes when the last call on it ends')
    expect(sessions).toContain('finds that Chrome closed')
    expect(sessions).toContain('whose `packs.enabled` leaves the browser out')
    expect(sessions).toContain('A call is masked by what the browser it reaches holds')
    expect(sessions).toContain('Another workspace, or another Buckle node, on the same folder has its own')
    expect(sessions).toContain('A session\'s first command runs alone')
    const masking = page('docs/user/how-to/secrets-02.md')
    expect(masking).toContain('a profile folder\'s, by what that folder\'s browser holds; an attached Chrome\'s, by what that Chrome holds')
    expect(masking).toContain('finds that Chrome closed')
    const limits = page('docs/user/caveats/known-limits-04.md')
    expect(limits).not.toContain('can still start two browsers')
    expect(limits).toContain('[Part ten](known-limits-10.md) lists what an attached Chrome\'s host and port leave')
    expect(page('docs/user/caveats/known-limits-10.md')).toContain('a remote browser service whose port stays open keeps its hold')
  })

  // Codex recheck L2 and L6, ruled known limits of an attached Chrome.
  it('names what an attached Chrome\'s host and port leave among the known limits', () => {
    const limits = page('docs/user/caveats/known-limits-10.md')
    expect(limits).toContain('a value filled through one name is not masked in a call through the other')
    expect(limits).toContain('A refused connection does not prove Chrome closed, as a proxy or forwarded port in front of it can stop while Chrome keeps its pages')
    expect(limits).toContain('](known-limits-04.md#the-browser)')
  })

  it('names what Windows still shows among the known limits', () => {
    const limits = page('docs/user/caveats/known-limits-04.md')
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
