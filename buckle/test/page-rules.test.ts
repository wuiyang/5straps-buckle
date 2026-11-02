import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The house rules every page meets: at most 1100 words, the cap a reader takes in at one sitting, and no en or em
// dash. Pages are the docs, every shipped SKILL.md, both READMEs, and .env.example, the settings reference.

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPOSITORY = join(PACKAGE, '..')
const MAX_WORDS = 1100
const LONG_DASH = /[\u2013\u2014]/

function filesUnder(directory: string, matches: (name: string) => boolean): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : filesUnder(path, matches)
    return matches(name) ? [path] : []
  })
}

const pages = [
  ...filesUnder(join(REPOSITORY, 'docs'), name => name.endsWith('.md')),
  ...filesUnder(join(PACKAGE, 'common', 'services', 'packs'), name => name === 'SKILL.md'),
  ...filesUnder(join(PACKAGE, 'skills'), name => name === 'SKILL.md'),
  join(REPOSITORY, 'README.md'),
  join(PACKAGE, 'README.md'),
  join(REPOSITORY, '.env.example'),
].map(path => ({ page: relative(REPOSITORY, path), text: readFileSync(path, 'utf8') }))

describe('every page', () => {
  it('reads the docs, every shipped skill, both READMEs, and .env.example', () => {
    expect(pages.length).toBeGreaterThan(20)
    expect(pages.map(item => item.page)).toEqual(expect.arrayContaining(['README.md', 'buckle/README.md', '.env.example', 'docs/user/how-to/browser-login.md', 'buckle/common/services/packs/browser/SKILL.md']))
  })

  it.each(pages)('$page stays at or under 1100 words', ({ text }) => {
    expect(text.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(MAX_WORDS)
  })

  it.each(pages)('$page holds no en or em dash', ({ text }) => {
    expect(text.split('\n').filter(line => LONG_DASH.test(line))).toEqual([])
  })
})
