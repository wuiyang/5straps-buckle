import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { forgeGitHost } from '../src/domain/forge.js'
import { classifyRemote, readOriginUrl, remoteSubject, repositoryOf } from '../src/packs/forge/remote.js'

const roots: string[] = []
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function repositoryWithOrigin(url: string): string {
  const root = mkdtempSync('/tmp/buckle-forge-remote-')
  roots.push(root)
  const repository = join(root, 'work')
  execFileSync('git', ['init', '-b', 'main', repository])
  execFileSync('git', ['-C', repository, 'remote', 'add', 'origin', url])
  return repository
}

describe('the host a forge API belongs to', () => {
  it('reads github.com behind api.github.com, which is where git is served', () => {
    expect(forgeGitHost(new URL('https://api.github.com'))).toBe('github.com')
  })

  it('leaves an enterprise host alone, where the API and git share one name', () => {
    expect(forgeGitHost(new URL('https://ghe.example.com/api/v3'))).toBe('ghe.example.com')
  })
})

describe('classifying an origin remote', () => {
  it('reads an https remote as a network reach, carrying the host the rules judge', () => {
    const remote = classifyRemote('https://github.com/wuiyang/demo.git')
    expect(remote.kind).toBe('https')
    if (remote.kind !== 'https') return
    expect(remote.host).toBe('github.com')
  })

  it('drops userinfo from the display, so a credential in the config never reaches a result', () => {
    const remote = classifyRemote('https://someone:secret-token@github.com/wuiyang/demo.git')
    expect(remote.display).toBe('https://github.com/wuiyang/demo.git')
    expect(remote.display).not.toContain('secret-token')
  })

  it('refuses an scp-style remote, because ssh would push under a key Buckle never judged', () => {
    expect(() => classifyRemote('git@github.com:wuiyang/demo.git')).toThrow(/ssh/)
  })

  it('refuses an ssh scheme for the same reason', () => {
    expect(() => classifyRemote('ssh://git@github.com/wuiyang/demo.git')).toThrow(/ssh/)
  })

  it('reads an absolute path as a repository on this filesystem', () => {
    expect(classifyRemote('/srv/origin.git')).toEqual({ kind: 'local', path: '/srv/origin.git', display: '/srv/origin.git' })
  })

  it('reads a file URL the same way', () => {
    expect(classifyRemote('file:///srv/origin.git').kind).toBe('local')
  })

  it('refuses an empty remote rather than guessing one', () => {
    expect(() => classifyRemote('  ')).toThrow(/no origin remote URL/)
  })
})

describe('the subject two remotes are compared on', () => {
  it('reads the same repository through the default port and the .git suffix', () => {
    expect(remoteSubject(classifyRemote('https://github.com/wuiyang/demo.git')))
      .toBe(remoteSubject(classifyRemote('https://github.com:443/wuiyang/demo/')))
  })

  it('separates another repository on the same host, which host and port alone would miss', () => {
    expect(remoteSubject(classifyRemote('https://github.com/wuiyang/demo.git')))
      .not.toBe(remoteSubject(classifyRemote('https://github.com/attacker/demo.git')))
  })

  it('separates another scheme and another port on the same host', () => {
    expect(remoteSubject(classifyRemote('https://github.com/wuiyang/demo')))
      .not.toBe(remoteSubject(classifyRemote('http://github.com/wuiyang/demo')))
    expect(remoteSubject(classifyRemote('https://github.com/wuiyang/demo')))
      .not.toBe(remoteSubject(classifyRemote('https://github.com:8443/wuiyang/demo')))
  })
})

describe('the repository an https remote names', () => {
  it('reads owner and name, with or without the .git suffix', () => {
    expect(repositoryOf(classifyRemote('https://github.com/wuiyang/demo.git'))).toEqual({ owner: 'wuiyang', name: 'demo' })
    expect(repositoryOf(classifyRemote('https://github.com/wuiyang/demo'))).toEqual({ owner: 'wuiyang', name: 'demo' })
  })

  it('refuses a local remote, which names no forge', () => {
    expect(() => repositoryOf(classifyRemote('/srv/origin.git'))).toThrow(/names no forge repository/)
  })
})

describe('reading the origin URL without running git', () => {
  it('finds it in the repository config', () => {
    const repository = repositoryWithOrigin('https://github.com/wuiyang/demo.git')
    expect(readOriginUrl(repository)).toBe('https://github.com/wuiyang/demo.git')
  })

  it('follows a linked worktree back to the repository holding the remotes', () => {
    const repository = repositoryWithOrigin('https://github.com/wuiyang/demo.git')
    writeFileSync(join(repository, 'README.md'), '# demo\n')
    execFileSync('git', ['-C', repository, 'add', 'README.md'])
    execFileSync('git', ['-C', repository, '-c', 'user.name=t', '-c', 'user.email=t@e.com', 'commit', '-m', 'first'])
    const worktree = join(repository, '..', 'linked')
    execFileSync('git', ['-C', repository, 'worktree', 'add', worktree, '-b', 'side'])
    expect(readOriginUrl(worktree)).toBe('https://github.com/wuiyang/demo.git')
  })

  it('refuses a directory that is not a repository', () => {
    const root = mkdtempSync('/tmp/buckle-forge-plain-')
    roots.push(root)
    expect(() => readOriginUrl(root)).toThrow(/not a git repository/)
  })

  it('refuses a repository with no origin', () => {
    const root = mkdtempSync('/tmp/buckle-forge-noremote-')
    roots.push(root)
    const repository = join(root, 'work')
    execFileSync('git', ['init', '-b', 'main', repository])
    expect(() => readOriginUrl(repository)).toThrow(/has no origin remote/)
  })

  it('refuses a config that includes another file rather than following it', () => {
    const repository = repositoryWithOrigin('https://github.com/wuiyang/demo.git')
    const included = join(repository, '..', 'included-config')
    writeFileSync(included, '[remote "origin"]\n\turl = https://github.com/attacker/demo.git\n')
    appendFileSync(join(repository, '.git', 'config'), `[include]\n\tpath = ${included}\n`)
    expect(() => readOriginUrl(repository)).toThrow(/includes another file/)
  })

  it('refuses a conditional include the same way', () => {
    const repository = repositoryWithOrigin('https://github.com/wuiyang/demo.git')
    appendFileSync(join(repository, '.git', 'config'), '[includeIf "gitdir:/"]\n\tpath = /tmp/anything\n')
    expect(() => readOriginUrl(repository)).toThrow(/includes another file/)
  })

  it('refuses a config larger than it will read, rather than pulling all of it into memory', () => {
    const repository = repositoryWithOrigin('https://github.com/wuiyang/demo.git')
    appendFileSync(join(repository, '.git', 'config'), `# ${'padding '.repeat(40_000)}\n`)
    expect(() => readOriginUrl(repository)).toThrow(/larger than the \d+ bytes/)
  })

  it('refuses a .git config that is not a regular file', () => {
    const repository = repositoryWithOrigin('https://github.com/wuiyang/demo.git')
    rmSync(join(repository, '.git', 'config'))
    mkdirSync(join(repository, '.git', 'config'))
    expect(() => readOriginUrl(repository)).toThrow(/not a git repository this pack can read/)
  })
})
