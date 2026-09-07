import { describe, expect, it } from 'vitest'
import { isCommandGlob } from '../src/domain/command-glob.js'
import { migrateCommandPattern } from '../src/domain/policy-migration.js'

function glob(source: string): string | null {
  return migrateCommandPattern(source).glob
}

describe('the regular expressions the node used to hold', () => {
  it.each([
    ['^docker compose (up|down|restart)\\b', 'docker compose {up,down,restart} *'],
    ['^pnpm (build|test)\\b', 'pnpm {build,test} *'],
    ['^(sh|bash|node|python3?|curl|wget)\\b', '{sh,bash,node,python3,python,curl,wget} *'],
    ['^rm -rf build$', 'rm -rf build'],
    ['^curl\\b', 'curl *'],
    ['^git push --force$', 'git push --force'],
    ['^node .*\\.js$', 'node *.js'],
  ])('reads %s as %s', (source, expected) => {
    expect(glob(source)).toBe(expected)
    expect(isCommandGlob(expected)).toBe(true)
  })

  it('says when a pattern was unanchored, because a glob always matches from the first word', () => {
    const migration = migrateCommandPattern('\\bwget\\b')
    expect(migration.glob).toBe('wget *')
    expect(migration.note).toContain('not anchored')
  })

  // `.*` reads as both: a regular expression matching anything, and a glob matching a word
  // starting with a dot. Nothing in the text says which, so it is left for the owner to read.
  it('leaves anything that already parses as a glob alone, .* included', () => {
    expect(migrateCommandPattern('.*')).toEqual({ source: '.*', glob: '.*', note: 'already a glob' })
  })

  it('leaves a pattern that is already a glob alone', () => {
    const migration = migrateCommandPattern('pnpm {build,test} *')
    expect(migration.glob).toBe('pnpm {build,test} *')
    expect(migration.note).toBe('already a glob')
  })
})

describe('what needs a person', () => {
  it.each([
    ['^ls [a-z]*$', 'a character class'],
    ['^(?=pnpm)', 'a lookahead'],
    ['^(a|b)?c', 'an optional group'],
    ['^pnpm (build|test', 'an unclosed group'],
    ['^\\d+ files', 'a character shorthand'],
    ['^pnpm(?: run)? build', 'an optional non-capturing group'],
  ])('refuses to guess at %s, %s', source => {
    const migration = migrateCommandPattern(source)
    expect(migration.glob).toBeNull()
    expect(migration.note).toBeTruthy()
  })
})
