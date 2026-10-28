import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'pathe'
import type { JsonObject, JsonValue } from '@5straps/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '../common/adapters/process-runner.js'
import { describeCall } from '../common/domain/describe-call.js'
import { forgeGitHost } from '../common/domain/forge.js'
import { createPathView } from '../common/domain/path-view.js'
import { createForgePack } from '../common/services/packs/forge/index.js'

// Slice D, rollback as an agent option, item 4: git_revert makes a new commit that undoes one (git revert --no-edit, no
// hard reset ever), under the node's agent identity and the forge pack's isolation, as git_commit commits. A merge commit
// needs mainline; a dirty work tree is refused by git itself, whose refusal is passed through; a conflict is aborted.

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const IDENTITY = ['-c', 'user.name=owner', '-c', 'user.email=owner@example.com']

function git(repository: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
}

/** A repository with three commits to a.txt and b.txt: first, second (a.txt two), third (b.txt changed). */
function repositoryWithHistory(): string {
  const root = mkdtempSync('/tmp/buckle-git-revert-')
  roots.push(root)
  const repository = join(root, 'work')
  execFileSync('git', ['init', '-q', '-b', 'main', repository])
  writeFileSync(join(repository, 'a.txt'), 'one\n')
  writeFileSync(join(repository, 'b.txt'), 'x\n')
  git(repository, 'add', '.')
  git(repository, ...IDENTITY, 'commit', '-q', '-m', 'first')
  writeFileSync(join(repository, 'a.txt'), 'two\n')
  git(repository, ...IDENTITY, 'commit', '-q', '-am', 'second')
  writeFileSync(join(repository, 'b.txt'), 'y\n')
  git(repository, ...IDENTITY, 'commit', '-q', '-am', 'third')
  return repository
}

function revertTool(repository: string) {
  const stateDirectory = mkdtempSync('/tmp/buckle-git-revert-state-')
  roots.push(stateDirectory)
  const pack = createForgePack({
    paths: createPathView({ root: repository, mount: null }),
    runProcess,
    git: { path: 'git', argv0: 'git', args: [] },
    stateDirectory,
    forge: { client: null, apiUrl: 'https://api.github.com', gitHost: forgeGitHost(new URL('https://api.github.com')), token: 'fixture-forge-token' },
    author: { name: '5straps agent', email: 'agent@5straps.local' },
    approved: null,
    unavailableReason: null,
  })
  const tool = pack.tools.find(candidate => candidate.capability.name === 'git_revert')
  if (!tool) throw new Error('the forge pack registered no git_revert')
  return tool
}

function revert(repository: string, args: JsonObject): Promise<JsonValue> {
  return revertTool(repository).prepare(args).execute({ requestId: 'r1', sessionId: 's1', timeoutMs: 20_000, signal: AbortSignal.timeout(20_000) })
}

describe('git_revert', () => {
  it('makes a new commit that undoes one, under the identity the owner configured', async () => {
    const repository = repositoryWithHistory()
    const second = git(repository, 'rev-parse', 'HEAD~1').trim()
    const output = await revert(repository, { commit: 'HEAD~1' }) as JsonObject
    expect(output).toMatchObject({ reverted: second, subject: 'Revert "second"', files: ['a.txt'] })
    expect(String(output.hash)).toBe(git(repository, 'rev-parse', 'HEAD').trim())
    expect(readFileSync(join(repository, 'a.txt'), 'utf8')).toBe('one\n')
    expect(readFileSync(join(repository, 'b.txt'), 'utf8')).toBe('y\n')
    expect(git(repository, 'log', '-1', '--format=%an <%ae>|%cn <%ce>').trim()).toBe('5straps agent <agent@5straps.local>|5straps agent <agent@5straps.local>')
    expect(git(repository, 'rev-list', '--count', 'HEAD').trim()).toBe('4')
  })

  it('declares a write on the repository as git_commit does, and a read of it as git_log does', () => {
    const repository = repositoryWithHistory()
    expect(revertTool(repository).prepare({ commit: 'HEAD' }).effects).toEqual([{ kind: 'write_path', path: '.' }, { kind: 'read_path', path: '.' }])
    expect(revertTool(repository).capability).toMatchObject({ risk: 'write', pack: 'forge' })
    expect(describeCall({ tool: 'git_revert', args: { repo: '.', commit: 'abc123' }, cwd: '/workspace' })).toBe('Revert commit "abc123" in "." in "/workspace"')
    expect(describeCall({ tool: 'git_revert', args: { repo: '.', commit: 'abc123', mainline: 1 }, cwd: '/workspace' })).toBe('Revert commit "abc123" (mainline 1) in "." in "/workspace"')
  })

  it('refuses a merge commit without mainline, and reverts it with one', async () => {
    const repository = repositoryWithHistory()
    git(repository, 'checkout', '-q', '-b', 'side', 'HEAD~2')
    writeFileSync(join(repository, 's.txt'), 's\n')
    git(repository, 'add', 's.txt')
    git(repository, ...IDENTITY, 'commit', '-q', '-m', 'side')
    git(repository, 'checkout', '-q', 'main')
    git(repository, ...IDENTITY, 'merge', '-q', '--no-edit', 'side')
    await expect(revert(repository, { commit: 'HEAD' })).rejects.toMatchObject({ code: 'INVALID_TOOL_INPUT', message: expect.stringContaining('is a merge commit; name mainline') })
    expect(existsSync(join(repository, 's.txt'))).toBe(true)
    expect(await revert(repository, { commit: 'HEAD', mainline: 1 })).toMatchObject({ files: ['s.txt'] })
    expect(existsSync(join(repository, 's.txt'))).toBe(false)
  })

  it('passes git\'s own refusal through for a dirty work tree or index, committing nothing and keeping the change', async () => {
    const repository = repositoryWithHistory()
    const head = git(repository, 'rev-parse', 'HEAD').trim()
    writeFileSync(join(repository, 'a.txt'), 'local edit\n')
    await expect(revert(repository, { commit: 'HEAD~1' })).rejects.toMatchObject({ code: 'GIT_FAILED', message: expect.stringMatching(/local changes .* would be overwritten/) })
    expect(readFileSync(join(repository, 'a.txt'), 'utf8')).toBe('local edit\n')
    git(repository, 'checkout', '--', 'a.txt')
    writeFileSync(join(repository, 'b.txt'), 'staged\n')
    git(repository, 'add', 'b.txt')
    await expect(revert(repository, { commit: 'HEAD~1' })).rejects.toMatchObject({ code: 'GIT_FAILED', message: expect.stringContaining('your local changes would be overwritten by revert') })
    expect(git(repository, 'rev-parse', 'HEAD').trim()).toBe(head)
  })

  it('aborts a revert that stops on a conflict, leaving the repository as it was and an unrelated change in place', async () => {
    const repository = repositoryWithHistory()
    writeFileSync(join(repository, 'a.txt'), 'three\n')
    git(repository, ...IDENTITY, 'commit', '-q', '-am', 'fourth')
    const head = git(repository, 'rev-parse', 'HEAD').trim()
    writeFileSync(join(repository, 'b.txt'), 'unrelated\n')
    await expect(revert(repository, { commit: 'HEAD~2' })).rejects.toMatchObject({ code: 'GIT_FAILED', message: expect.stringContaining('stopped on a conflict and was aborted') })
    expect(git(repository, 'rev-parse', 'HEAD').trim()).toBe(head)
    expect(existsSync(join(repository, '.git', 'REVERT_HEAD'))).toBe(false)
    expect(readFileSync(join(repository, 'a.txt'), 'utf8')).toBe('three\n')
    expect(readFileSync(join(repository, 'b.txt'), 'utf8')).toBe('unrelated\n')
  })

  it('refuses a commit named like a flag or naming no commit, before anything is reverted', async () => {
    const repository = repositoryWithHistory()
    await expect(revert(repository, { commit: '--abort' })).rejects.toMatchObject({ code: 'INVALID_TOOL_INPUT', message: expect.stringContaining('Not a usable commit name') })
    await expect(revert(repository, { commit: 'no-such-branch' })).rejects.toMatchObject({ message: expect.stringContaining('names no commit in this repository') })
    expect(git(repository, 'rev-list', '--count', 'HEAD').trim()).toBe('3')
  })

  it('refuses a repository that defines a merge driver or a filter, whose program a revert would run, and runs no hook', async () => {
    const repository = repositoryWithHistory()
    const marker = join(repository, 'ran.txt')
    writeFileSync(join(repository, 'driver.sh'), `#!/bin/sh\ntouch ${marker}\nexit 0\n`, { mode: 0o755 })
    git(repository, 'config', 'merge.pwn.driver', `${join(repository, 'driver.sh')} %O %A %B`)
    await expect(revert(repository, { commit: 'HEAD~1' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining('merge driver') })
    git(repository, 'config', '--unset', 'merge.pwn.driver')
    git(repository, 'config', 'filter.pwn.smudge', join(repository, 'driver.sh'))
    await expect(revert(repository, { commit: 'HEAD~1' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    git(repository, 'config', '--remove-section', 'filter.pwn')
    mkdirSync(join(repository, '.git', 'hooks'), { recursive: true })
    for (const hook of ['pre-commit', 'commit-msg', 'post-commit']) writeFileSync(join(repository, '.git', 'hooks', hook), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 })
    expect(await revert(repository, { commit: 'HEAD~1' })).toMatchObject({ files: ['a.txt'] })
    expect(existsSync(marker)).toBe(false)
  })
})
