import { describe, expect, it } from 'vitest'
import { CommandGlobError, compileCommandGlob, splitByCommandWord } from '../common/domain/command-glob.js'

function line(pattern: string, words: string[]): boolean {
  return compileCommandGlob(pattern).matchesLine(words)
}

function prefix(pattern: string, words: string[]): boolean {
  return compileCommandGlob(pattern).matchesPrefix(words)
}

describe('the rulings own examples', () => {
  it('allows a compose call under docker compose {up,down,restart} *', () => {
    expect(line('docker compose {up,down,restart} *', ['docker', 'compose', 'up', '-d'])).toBe(true)
    expect(line('docker compose {up,down,restart} *', ['docker', 'compose', 'logs'])).toBe(false)
  })

  it('denies an interpreter under {sh,node,python,curl,wget}, whatever it is handed', () => {
    expect(prefix('{sh,node,python,curl,wget}', ['node', '-e', '1'])).toBe(true)
    expect(prefix('{sh,node,python,curl,wget}', ['pnpm', 'build'])).toBe(false)
  })

  it('runs pnpm build under pnpm {build,test} *, and refuses pnpm install', () => {
    expect(line('pnpm {build,test} *', ['pnpm', 'build'])).toBe(true)
    expect(line('pnpm {build,test} *', ['pnpm', 'build', '--filter', 'web'])).toBe(true)
    expect(line('pnpm {build,test} *', ['pnpm', 'install'])).toBe(false)
  })
})

describe('a whole line against a leading run', () => {
  it('makes an allow glob cover every word, so an unnamed flag never rides along', () => {
    expect(line('docker compose up', ['docker', 'compose', 'up'])).toBe(true)
    expect(line('docker compose up', ['docker', 'compose', 'up', '--privileged'])).toBe(false)
  })

  it('makes a deny glob cover whatever follows it', () => {
    expect(prefix('docker compose up', ['docker', 'compose', 'up', '--privileged'])).toBe(true)
    expect(prefix('docker compose up', ['docker', 'compose'])).toBe(false)
  })
})

describe('words', () => {
  it('matches literals one word at a time', () => {
    expect(line('git status', ['git', 'status'])).toBe(true)
    expect(line('git status', ['git', 'statusx'])).toBe(false)
    expect(line('git status', ['git'])).toBe(false)
  })

  it('reads a single * as exactly one word', () => {
    expect(line('git * --force', ['git', 'push', '--force'])).toBe(true)
    expect(line('git * --force', ['git', '--force'])).toBe(false)
    expect(line('git * --force', ['git', 'remote', 'push', '--force'])).toBe(false)
  })

  it('reads a trailing * as the rest of the line, including nothing', () => {
    expect(line('bash -c *', ['bash', '-c'])).toBe(true)
    expect(line('bash -c *', ['bash', '-c', 'pnpm build'])).toBe(true)
    expect(line('bash -c *', ['bash', '-lc', 'pnpm build'])).toBe(false)
  })

  it('reads ** as any run of words wherever it stands', () => {
    expect(line('git ** --force', ['git', 'push', 'origin', 'main', '--force'])).toBe(true)
    expect(line('git ** --force', ['git', '--force'])).toBe(true)
    expect(line('git ** --force', ['git', 'push'])).toBe(false)
  })
})

describe('inside one word', () => {
  it('matches a run of characters with *', () => {
    expect(line('node --port=*', ['node', '--port=3000'])).toBe(true)
    expect(line('node --port=*', ['node', '--port'])).toBe(false)
    expect(line('tsc *.ts', ['tsc', 'src/app.ts'])).toBe(true)
    expect(line('tsc *.ts', ['tsc', 'src/app.js'])).toBe(false)
  })

  it('matches one of the alternatives with { }', () => {
    expect(line('pnpm --filter={web,api}', ['pnpm', '--filter=api'])).toBe(true)
    expect(line('pnpm --filter={web,api}', ['pnpm', '--filter=db'])).toBe(false)
  })

  it('combines alternatives with wildcards', () => {
    expect(line('pnpm {build,test}:* *', ['pnpm', 'test:unit', '--watch'])).toBe(true)
    expect(line('pnpm {build,test}:* *', ['pnpm', 'lint:all'])).toBe(false)
  })

  it('is case sensitive, matching argv as the shell handed it over', () => {
    expect(line('git status', ['git', 'STATUS'])).toBe(false)
  })
})

describe('what a pattern may not be', () => {
  it.each(['^pnpm', 'pnpm$', 'pnpm (build|test)', 'python3?', 'a\\b', 'ls [a-z]', 'a+'])('refuses the regular expression %s', pattern => {
    expect(() => compileCommandGlob(pattern)).toThrow(CommandGlobError)
  })

  it('says a command pattern is a glob, without pointing at a migration command', () => {
    expect(() => compileCommandGlob('^pnpm (build|test)\\b')).toThrow('a command pattern is a shell-word glob')
    expect(() => compileCommandGlob('^pnpm (build|test)\\b')).not.toThrow('migrate')
  })

  it.each(['', '   '])('refuses an empty pattern %s', pattern => {
    expect(() => compileCommandGlob(pattern)).toThrow(CommandGlobError)
  })

  it.each(['pnpm {build', 'pnpm build}', 'pnpm {a{b,c},d}', 'pnpm {build,}'])('refuses malformed braces in %s', pattern => {
    expect(() => compileCommandGlob(pattern)).toThrow(CommandGlobError)
  })

  it('refuses more alternatives than a word can usefully hold', () => {
    const many = Array.from({ length: 9 }, () => '{a,b}').join('')
    expect(() => compileCommandGlob(`pnpm ${many}`)).toThrow(CommandGlobError)
  })
})


// D74 (bare words only): a glob meets a command word written as a path only by the alternatives that spell a path, so
// each alternative of its command word counts on its own (review 1 of the git pack, held[3]).
describe('a glob split by the alternatives of its command word', () => {
  it('gives the bare alternatives and the path alternatives each a glob of their own, with the words after them', () => {
    const { bare, path } = splitByCommandWord(compileCommandGlob('{git,*git,/usr/bin/git,*/git} status'))
    expect(bare?.source).toBe('{git,*git,/usr/bin/git,*/git} status')
    expect(bare?.matchesLine(['git', 'status'])).toBe(true)
    expect(bare?.matchesLine(['sgit', 'status'])).toBe(true)
    expect(bare?.matchesLine(['git', 'push'])).toBe(false)
    expect(path?.matchesLine(['/usr/bin/git', 'status'])).toBe(true)
    expect(path?.matchesLine(['./x/git', 'status'])).toBe(true)
    expect(path?.matchesLine(['git', 'status'])).toBe(false)
    expect(path?.matchesLine(['/usr/bin/git', 'push'])).toBe(false)
  })

  it('leaves a half with no alternatives empty, and reads ** or a lone * as bare', () => {
    expect(splitByCommandWord(compileCommandGlob('/usr/bin/git status')).bare).toBeNull()
    expect(splitByCommandWord(compileCommandGlob('git status')).path).toBeNull()
    for (const source of ['**', '*', '** status']) {
      const glob = compileCommandGlob(source)
      expect(splitByCommandWord(glob)).toEqual({ bare: glob, path: null })
    }
  })
})
