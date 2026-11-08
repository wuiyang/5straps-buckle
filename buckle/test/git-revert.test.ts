import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'pathe'
import type { JsonObject, JsonValue } from '@5straps/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '../common/adapters/process-runner.js'
import { describeCall } from '../common/domain/describe-call.js'
import { forgeGitHost } from '../common/domain/forge.js'
import { createPathView } from '../common/domain/path-view.js'
import type { ToolContext } from '../common/domain/tool.js'
import { createForgePack } from '../common/services/packs/forge/index.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { SOURCES } from '../common/types/ports/approval-source.js'
import { settleAuditLogs } from './support/action-log-writer.js'

// Slice D, rollback as an agent option, item 4: git_revert makes a new commit that undoes one (git revert --no-edit, no
// hard reset ever), under the node's agent identity and the forge pack's isolation, as git_commit commits. A merge commit
// needs mainline; a dirty work tree is refused by git itself, whose refusal is passed through; a conflict is aborted.

const roots: string[] = []
afterEach(async () => { await settleAuditLogs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const IDENTITY = ['-c', 'user.name=owner', '-c', 'user.email=owner@example.com']

function git(repository: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
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

function revert(repository: string, args: JsonObject, context: Partial<ToolContext> = {}): Promise<JsonValue> {
  return revertTool(repository).prepare(args).execute({ requestId: 'r1', sessionId: 's1', timeoutMs: 20_000, signal: AbortSignal.timeout(20_000), ...context })
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

  // Review B1 of the Slice D rules review: a revert the owner has stopped on a conflict is theirs, and the tool's own
  // `git revert --abort` (a `reset --merge`) must never run on it, so the call is refused and everything stays.
  it.each([
    ['a staged resolution', true],
    ['an unmerged, half resolved file', false],
  ])('refuses while the owner has a revert in progress, keeping %s and the revert state', async (_name, staged) => {
    const repository = repositoryWithHistory()
    writeFileSync(join(repository, 'a.txt'), 'three\n')
    git(repository, ...IDENTITY, 'commit', '-q', '-am', 'fourth')
    const head = git(repository, 'rev-parse', 'HEAD').trim()
    expect(() => git(repository, ...IDENTITY, 'revert', '--no-edit', 'HEAD~2')).toThrow()
    const revertHead = git(repository, 'rev-parse', 'REVERT_HEAD').trim()
    writeFileSync(join(repository, 'a.txt'), 'resolved by hand\n')
    if (staged) git(repository, 'add', 'a.txt')
    await expect(revert(repository, { commit: 'HEAD' })).rejects.toMatchObject({ message: expect.stringContaining('in progress') })
    expect(readFileSync(join(repository, 'a.txt'), 'utf8')).toBe('resolved by hand\n')
    expect(git(repository, 'rev-parse', 'REVERT_HEAD').trim()).toBe(revertHead)
    expect(git(repository, 'rev-parse', 'HEAD').trim()).toBe(head)
    expect(git(repository, 'status', '--porcelain', '--', 'a.txt')).toMatch(staged ? /^M {2}a\.txt/ : /^(UU|AA|DU|UD) a\.txt/)
  })

  it.each([
    ['a cherry-pick', 'cherry-pick'],
    ['a merge', 'merge'],
  ])('refuses while the owner has %s stopped on a conflict, and leaves it as it is', async (_name, kind) => {
    const repository = repositoryWithHistory()
    git(repository, 'checkout', '-q', '-b', 'side', 'HEAD~2')
    writeFileSync(join(repository, 'a.txt'), 'side\n')
    git(repository, ...IDENTITY, 'commit', '-q', '-am', 'side')
    git(repository, 'checkout', '-q', 'main')
    expect(() => git(repository, ...IDENTITY, kind, ...(kind === 'merge' ? ['--no-edit', 'side'] : ['side']))).toThrow()
    const state = kind === 'merge' ? 'MERGE_HEAD' : 'CHERRY_PICK_HEAD'
    const before = readFileSync(join(repository, 'a.txt'), 'utf8')
    await expect(revert(repository, { commit: 'HEAD' })).rejects.toMatchObject({ message: expect.stringContaining('in progress') })
    expect(existsSync(join(repository, '.git', state))).toBe(true)
    expect(readFileSync(join(repository, 'a.txt'), 'utf8')).toBe(before)
  })

  // Review M3 of the Slice D tests review: each guard is pinned on its own, a filter program defined where the config text
  // does not say it (a worktree config) and a filter attribute with no driver defined anywhere.
  it('refuses a filter program git resolves from the worktree config, which the revert would run on a restored .gitattributes', async () => {
    const repository = repositoryWithHistory()
    const marker = join(repository, 'filter-ran.txt')
    writeFileSync(join(repository, 'filter.sh'), `#!/bin/sh\ntouch ${marker}\ncat\n`, { mode: 0o755 })
    writeFileSync(join(repository, '.gitattributes'), 'a.txt filter=pwn\n')
    git(repository, 'add', '.gitattributes')
    git(repository, ...IDENTITY, 'commit', '-q', '-m', 'attributes')
    git(repository, 'rm', '-q', '.gitattributes')
    git(repository, ...IDENTITY, 'commit', '-q', '-m', 'no attributes')
    git(repository, 'config', 'extensions.worktreeConfig', 'true')
    git(repository, 'config', '--worktree', 'filter.pwn.smudge', join(repository, 'filter.sh'))
    git(repository, 'config', '--worktree', 'filter.pwn.clean', join(repository, 'filter.sh'))
    expect(readFileSync(join(repository, '.git', 'config'), 'utf8')).not.toMatch(/\[filter/)
    const head = git(repository, 'rev-parse', 'HEAD').trim()
    await expect(revert(repository, { commit: 'HEAD' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining('defines the git filter program') })
    expect(existsSync(marker)).toBe(false)
    expect(git(repository, 'rev-parse', 'HEAD').trim()).toBe(head)
  })

  it('refuses a committed filter attribute, though no driver is defined anywhere', async () => {
    const repository = repositoryWithHistory()
    writeFileSync(join(repository, '.gitattributes'), 'a.txt filter=pwn\n')
    writeFileSync(join(repository, 'a.txt'), 'four\n')
    git(repository, 'add', '.')
    git(repository, ...IDENTITY, 'commit', '-q', '-m', 'attributes and a change')
    const head = git(repository, 'rev-parse', 'HEAD').trim()
    await expect(revert(repository, { commit: 'HEAD' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining('gives a committed path a filter attribute') })
    expect(git(repository, 'rev-parse', 'HEAD').trim()).toBe(head)
  })

  // Review m3 of the Slice D rules review: a revert rewrites the work tree, so each file it rewrites is judged as a write
  // before git starts, and one the rules do not let this call write refuses the whole revert.
  it('judges each file the revert rewrites as a write, and reverts nothing where one is not allowed', async () => {
    const repository = repositoryWithHistory()
    writeFileSync(join(repository, 'secret.txt'), 'one\n')
    git(repository, 'add', 'secret.txt')
    git(repository, ...IDENTITY, 'commit', '-q', '-m', 'secret')
    writeFileSync(join(repository, 'secret.txt'), 'two\n')
    writeFileSync(join(repository, 'a.txt'), 'three\n')
    git(repository, ...IDENTITY, 'commit', '-q', '-am', 'both')
    const head = git(repository, 'rev-parse', 'HEAD').trim()
    const judged: string[] = []
    const except = (name: string) => async (path: string) => { judged.push(path.slice(repository.length + 1)); return !path.endsWith(name) }
    await expect(revert(repository, { commit: 'HEAD' }, { authorizeWritePath: except('secret.txt') })).rejects.toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining('secret.txt') })
    expect(judged).toEqual(['a.txt', 'secret.txt'])
    expect(git(repository, 'rev-parse', 'HEAD').trim()).toBe(head)
    expect(readFileSync(join(repository, 'secret.txt'), 'utf8')).toBe('two\n')
    expect(await revert(repository, { commit: 'HEAD' }, { authorizeWritePath: except('nothing') })).toMatchObject({ files: ['a.txt', 'secret.txt'] })
    expect(readFileSync(join(repository, 'secret.txt'), 'utf8')).toBe('one\n')
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
    await expect(revert(repository, { commit: 'HEAD~1' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining('defines the git filter program') })
    git(repository, 'config', '--remove-section', 'filter.pwn')
    mkdirSync(join(repository, '.git', 'hooks'), { recursive: true })
    for (const hook of ['pre-commit', 'commit-msg', 'post-commit']) writeFileSync(join(repository, '.git', 'hooks', hook), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 })
    expect(await revert(repository, { commit: 'HEAD~1' })).toMatchObject({ files: ['a.txt'] })
    expect(existsSync(marker)).toBe(false)
  })
})

describe('git_revert through the runtime', () => {
  const runtimes: CoreRuntime[] = []
  afterEach(async () => { for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() } })

  async function node(repository: string, options: { grant?: boolean } = {}): Promise<CoreRuntime> {
    const state = mkdtempSync('/tmp/buckle-git-revert-node-')
    roots.push(state)
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: repository, BUCKLE_STATE_DIR: state, BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs,git,forge', BUCKLE_ALLOW_HOST_GIT: 'true', BUCKLE_FORGE_GITHUB_TOKEN: 'ghp-git-revert-fixture', BUCKLE_FORGE_GITHUB_API_URL: 'https://api.github.com' })
    const runtime = await createRuntime({ config })
    runtimes.push(runtime)
    if (options.grant !== false) await runtime.grants.grant({ sessionId: 'agent', rule: 'write_scope', subject: runtime.paths().root, scope: 'session' })
    return runtime
  }

  const revertCall = (runtime: CoreRuntime, requestId: string, args: JsonObject) => runtime.invoke({ request: { requestId, tool: 'git_revert', args, approvalTokens: [] }, sessionId: 'agent' })

  it('refuses a revert that would rewrite a credential file the workspace\'s rules would ask about, and reverts one that does not', async () => {
    const repository = repositoryWithHistory()
    writeFileSync(join(repository, '.env'), 'TOKEN=one\n')
    git(repository, 'add', '.env')
    git(repository, ...IDENTITY, 'commit', '-q', '-m', 'env')
    writeFileSync(join(repository, '.env'), 'TOKEN=two\n')
    git(repository, ...IDENTITY, 'commit', '-q', '-am', 'rotate')
    const head = git(repository, 'rev-parse', 'HEAD').trim()
    const runtime = await node(repository)
    expect(await revertCall(runtime, 'revert-env', { commit: 'HEAD' })).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('.env') } })
    expect(git(repository, 'rev-parse', 'HEAD').trim()).toBe(head)
    expect(readFileSync(join(repository, '.env'), 'utf8')).toBe('TOKEN=two\n')
    expect(await revertCall(runtime, 'revert-third', { commit: 'HEAD~2' })).toMatchObject({ outcome: 'ok', output: { files: ['b.txt'] } })
    expect(readFileSync(join(repository, 'b.txt'), 'utf8')).toBe('x\n')
    expect(readFileSync(join(repository, '.env'), 'utf8')).toBe('TOKEN=two\n')
  })

  it('counts the folder\'s approval a person gave once for the call as allowing the files in it, so an approved revert runs', async () => {
    const repository = repositoryWithHistory()
    const runtime = await node(repository, { grant: false })
    const asked = await revertCall(runtime, 'revert-second', { commit: 'HEAD~1' })
    expect(asked.outcome).toBe('approval_required')
    const tokens = asked.outcome === 'approval_required' ? asked.approvals.map(approval => approval.token) : []
    for (const token of tokens) expect((await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'once' }, source: SOURCES.cli })).ok).toBe(true)
    const sent = await runtime.invoke({ request: { requestId: 'revert-second', tool: 'git_revert', args: { commit: 'HEAD~1' }, approvalTokens: tokens }, sessionId: 'agent' })
    expect(sent).toMatchObject({ outcome: 'ok', output: { files: ['a.txt'] } })
    expect(readFileSync(join(repository, 'a.txt'), 'utf8')).toBe('one\n')
  })
})
