import { execFileSync } from 'node:child_process'
import nodeFs, { appendFileSync, chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, realpathSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { emptyWorkspacePolicy, type FilesystemPermission, type JsonValue } from '@5straps/protocol'
import { runProcess as hostRunProcess } from '../common/adapters/process-runner.js'
import { findExecutable } from '../common/domain/executable.js'
import type { HostEnvironment } from '../common/domain/environment.js'
import { createFilesystemPolicyRule } from '../common/domain/filesystem-policy.js'
import { createPermissionEngine } from '../common/domain/permission/engine.js'
import { createReadScopeRule } from '../common/domain/permission/rules/read-scope-rule.js'
import { createSensitivePathRule } from '../common/domain/permission/rules/sensitive-path-rule.js'
import { createPathView } from '../common/domain/path-view.js'
import { resolveEffects } from '../common/services/invocation/resolve-effects.js'
import { createGitPack } from '../common/services/packs/git/index.js'
import type { ToolContext } from '../common/domain/tool.js'
import type { ProcessRequest, ProcessRunner } from '../common/types/ports/process-runner.js'

function gitPack(root: string, runProcess: ProcessRunner = vi.fn(), mount: string | null = null, git = 'git') {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'git-pack-state-'))
  const pack = createGitPack({ paths: createPathView({ root, mount, scratchRoots: [] }), runProcess, stateDirectory, git: { path: git, argv0: 'git', args: [] } })
  const call = (name: string, args: Record<string, JsonValue>, judged: Pick<ToolContext, 'authorizeReadTarget'> = {}) => {
    const tool = pack.tools.find(candidate => candidate.capability.name === name)
    if (!tool) throw new Error(`No such tool: ${name}`)
    return tool.prepare(args).execute({ requestId: 'req-1', sessionId: 'chat-1', timeoutMs: 1_000, signal: AbortSignal.timeout(1_000), ...judged })
  }
  return { call, runProcess }
}

/** A git that answers every call with nothing, and the repository it is asked about as one with its own `.git`. */
/** What a call was refused with, or null where it ran: a refusal at prepare time is thrown rather than returned. */
async function refusalOf(run: () => Promise<unknown>): Promise<unknown> {
  try { await run(); return null } catch (error) { return error }
}

function answering() {
  return vi.fn<ProcessRunner>(async request => ({
    exitCode: 0, signal: null, stderr: '', truncated: false, timedOut: false,
    stdout: request.args[0] === 'rev-parse' ? `${request.cwd}\n${request.cwd}/.git\n${request.cwd}/.git\n` : '',
  }))
}

describe('a git tool pointed at a directory that is not there', () => {
  it('names the missing directory rather than reading as a missing git binary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-pack-'))
    const { call, runProcess } = gitPack(root)

    await expect(call('git_status', { repo: 'nowhere' })).rejects.toThrow('No such directory in this workspace: nowhere')
    await expect(call('git_status', { repo: 'nowhere' })).rejects.not.toThrow(/ENOENT/)
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('names it the same way for every git tool, not only the status one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-pack-'))
    const { call } = gitPack(root)

    for (const [tool, args] of [['git_diff', {}], ['git_log', {}], ['git_branch', {}], ['git_blame', { path: 'a.txt' }]] as const) {
      await expect(call(tool, { ...args, repo: 'nowhere' })).rejects.toThrow('No such directory in this workspace: nowhere')
    }
  })

  it('says so when the path is a file rather than a directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-pack-'))
    writeFileSync(join(root, 'a.txt'), 'a')
    const { call } = gitPack(root)

    await expect(call('git_status', { repo: 'a.txt' })).rejects.toThrow('Not a directory: a.txt')
  })
})

// Review L5 of the second proof-of-possession re-review: host git ran in the repository as the agent named it,
// so a link swapped during an approval wait made git read another repository than the one judged, and
// git_blame never judged its repository at all.
describe('a git tool runs in the repository its permission check judged', () => {
  function repositories() {
    const root = mkdtempSync(join(tmpdir(), 'git-pack-judged-'))
    for (const name of ['repoA', 'repoB']) mkdirSync(join(root, name, '.git'), { recursive: true })
    symlinkSync('repoA', join(root, 'repo'))
    return root
  }

  it('hands git the judged real path, not the link it was named by', async () => {
    const root = repositories()
    const runProcess = answering()
    const { call } = gitPack(root, runProcess)
    await call('git_status', { repo: 'repo' }, { authorizeReadTarget: target => target === join(root, 'repoA') })
    expect(runProcess.mock.calls.map(([request]) => request.cwd)).toEqual(expect.arrayContaining([join(root, 'repoA')]))
    expect(runProcess.mock.calls.every(([request]) => request.cwd === join(root, 'repoA'))).toBe(true)
  })

  it.each([['git_status', {}], ['git_log', {}], ['git_diff', {}], ['git_branch', {}], ['git_blame', { path: 'a.txt' }]] as const)('refuses %s when the repository link was swapped after the check, and runs nothing', async (tool, args) => {
    const root = repositories()
    const { call, runProcess } = gitPack(root)
    unlinkSync(join(root, 'repo'))
    symlinkSync('repoB', join(root, 'repo'))
    await expect(call(tool, { ...args, repo: 'repo' }, { authorizeReadTarget: target => target === join(root, 'repoA') || target.startsWith(`${join(root, 'repoA')}/`) })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('judges git_blame\'s repository and the file under it, not the file under the workspace root', () => {
    const root = repositories()
    const pack = createGitPack({ paths: createPathView({ root, mount: null, scratchRoots: [] }), runProcess: vi.fn(), stateDirectory: mkdtempSync(join(tmpdir(), 'git-pack-state-')), git: { path: 'git', argv0: 'git', args: [] } })
    const blame = pack.tools.find(candidate => candidate.capability.name === 'git_blame')!
    expect(blame.prepare({ repo: 'repo', path: 'src/a.txt' }).effects).toEqual([{ kind: 'read_path', path: 'repo' }, { kind: 'read_path', path: 'repo/src/a.txt' }])
  })
})

// git_blame judged where the file really is and then handed git the agent's own string, which git resolves again: a link
// swapped after the check, or a name git reads otherwise, reached another file than the one judged.
describe('git_blame hands git the file its permission check judged', () => {
  function repository() {
    const root = mkdtempSync(join(tmpdir(), 'git-pack-blame-'))
    for (const directory of ['src', '.git']) mkdirSync(join(root, 'repoA', directory), { recursive: true })
    for (const name of ['a.txt', 'b.txt']) writeFileSync(join(root, 'repoA', 'src', name), `${name}\n`)
    symlinkSync('repoA', join(root, 'repo'))
    symlinkSync('src', join(root, 'repoA', 'alias'))
    symlinkSync('a.txt', join(root, 'repoA', 'src', 'current.txt'))
    return root
  }
  const ran = answering
  const judgedUnder = (root: string) => ({ authorizeReadTarget: (target: string) => [join(root, 'repoA'), join(root, 'repoA', 'src', 'a.txt')].includes(target) })

  it('as its real path relative to the real repository, whatever links and dots the agent named it by', async () => {
    const root = repository()
    for (const path of ['src/a.txt', 'alias/a.txt', 'src/../src/current.txt', join(root, 'repo', 'alias', 'current.txt')]) {
      const runProcess = ran()
      const { call } = gitPack(root, runProcess)
      await call('git_blame', { repo: 'repo', path }, judgedUnder(root))
      const blame = runProcess.mock.calls.at(-1)![0]
      expect(blame.cwd).toBe(join(root, 'repoA'))
      expect(blame.args.slice(-2)).toEqual(['--', 'src/a.txt'])
    }
  })

  it('refuses a file link swapped after the check, and runs nothing', async () => {
    const root = repository()
    const { call, runProcess } = gitPack(root)
    unlinkSync(join(root, 'repoA', 'src', 'current.txt'))
    symlinkSync('b.txt', join(root, 'repoA', 'src', 'current.txt'))
    await expect(call('git_blame', { repo: 'repo', path: 'src/current.txt' }, judgedUnder(root))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(runProcess).not.toHaveBeenCalled()
  })
})

// Started in a workspace folder that holds no repository of its own, git climbed to the repository above it: status listed
// `../.ssh/config`, diff printed it, and log showed its commits, through a mount too, while only the folder was judged.
const hostGit = findExecutable('git')
describe.skipIf(hostGit === null)('a git tool reads only a repository inside the root it runs in', () => {
  const quiet = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, env: quiet, stdio: 'pipe' })
  function repository(directory: string, file: string): void {
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, file), 'committed\n')
    git(directory, 'init', '-q')
    git(directory, 'add', file)
    git(directory, 'commit', '-qm', `commit of ${file}`)
    writeFileSync(join(directory, file), 'changed\n')
  }
  /** A home folder that is a repository tracking a secret, and a workspace inside it that is none. */
  function enclosed() {
    const home = join(realpathSync(mkdtempSync(join(tmpdir(), 'git-pack-enclosed-'))), 'home')
    repository(home, 'outer-secret.txt')
    const workspace = join(home, 'project')
    mkdirSync(workspace)
    writeFileSync(join(workspace, 'inside.txt'), 'inside\n')
    return { home, workspace }
  }
  const tools = [['git_status', {}], ['git_diff', {}], ['git_log', {}], ['git_branch', {}]] as const
  const KEEPS = 'keeps its files or history outside the root'

  it.each([[null, '.'], ['/workspace', '/workspace']] as const)('refuses status, diff, log, and branch from a workspace inside another repository, mounted at %s, with nothing of it shown', async (mount, repo) => {
    const { workspace } = enclosed()
    const { call } = gitPack(workspace, hostRunProcess, mount, hostGit!)
    for (const [tool, args] of tools) {
      const refusal = await call(tool, { ...args, repo }).then(() => null, (error: unknown) => error)
      expect(refusal).toMatchObject({ code: 'GIT_NO_REPOSITORY' })
      expect(String(refusal)).not.toMatch(/outer-secret|commit of|main/)
    }
  })

  it('refuses a repository in the workspace whose git directory lies outside it', async () => {
    const { home, workspace } = enclosed()
    writeFileSync(join(workspace, '.git'), `gitdir: ${join(home, '.git')}\n`)
    const { call } = gitPack(workspace, hostRunProcess, null, hostGit!)
    for (const [tool, args] of tools) await expect(call(tool, { ...args, repo: '.' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining(KEEPS) })
  })

  // Only the boundary check refuses these: without it, core.worktree outside ran status, diff, and log on the outside
  // files, and the objects check refused the rest with another reason (git pack recheck 3, held[3]).
  const fresh = () => realpathSync(mkdtempSync(join(tmpdir(), 'git-pack-boundary-')))
  async function keptOutside(call: ReturnType<typeof gitPack>['call'], repo: string) {
    for (const [tool, args] of [['git_status', {}], ['git_log', {}], ['git_diff', {}]] as const) {
      const refusal = await refusalOf(() => call(tool, { ...args, repo }))
      expect(refusal).toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining(KEEPS) })
      expect(String(refusal)).not.toMatch(/outer/)
    }
  }

  it.each<[string, (root: string, outside: string) => string]>([
    ['core.worktree naming a folder outside the root', (root, outside) => {
      repository(join(root, 'repo'), 'inner.txt')
      repository(outside, 'outer.txt')
      git(join(root, 'repo'), 'config', 'core.worktree', outside)
      return 'repo'
    }],
    ['a linked worktree whose main repository is outside the root', (root, outside) => {
      repository(outside, 'outer.txt')
      git(outside, 'worktree', 'add', '-q', '-b', 'linked', join(root, 'wt'))
      return 'wt'
    }],
    ['a commondir file naming the git folder of a repository outside the root', (root, outside) => {
      repository(join(root, 'repo'), 'inner.txt')
      repository(outside, 'outer.txt')
      writeFileSync(join(root, 'repo', '.git', 'commondir'), `${join(outside, '.git')}\n`)
      return 'repo'
    }],
  ])('refuses status, log, and diff of a repository with %s, with nothing of it shown', async (_, build) => {
    const root = fresh()
    const repo = build(root, join(fresh(), 'outer'))
    await keptOutside(gitPack(root, hostRunProcess, null, hostGit!).call, repo)
  })

  it('refuses a .git file naming a git folder in another root the node reaches, outside the root holding the repository', async () => {
    const root = fresh()
    const scratch = fresh()
    repository(join(scratch, 'outer'), 'outer.txt')
    mkdirSync(join(root, 'repo'))
    writeFileSync(join(root, 'repo', '.git'), `gitdir: ${join(scratch, 'outer', '.git')}\n`)
    const pack = createGitPack({ paths: createPathView({ root, mount: null, scratchRoots: [scratch] }), runProcess: hostRunProcess, stateDirectory: mkdtempSync(join(tmpdir(), 'git-pack-state-')), git: { path: hostGit!, argv0: 'git', args: [] } })
    const call = (name: string, args: Record<string, JsonValue>) => pack.tools.find(tool => tool.capability.name === name)!.prepare(args).execute({ requestId: 'req-1', sessionId: 'chat-1', timeoutMs: 5_000, signal: AbortSignal.timeout(5_000) })
    await keptOutside(call, 'repo')
  })

  it('still reads a workspace that is a repository, from its root or a folder in it, and a repository nested inside it', async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'git-pack-own-')))
    repository(workspace, 'own.txt')
    repository(join(workspace, 'nested'), 'nested.txt')
    mkdirSync(join(workspace, 'src'))
    const { call } = gitPack(workspace, hostRunProcess, null, hostGit!)
    expect(await call('git_status', { repo: '.' })).toMatchObject({ branch: 'main', entries: expect.arrayContaining([{ state: '.M', path: 'own.txt' }]) })
    expect(await call('git_log', { repo: 'src' })).toMatchObject({ commits: [{ subject: 'commit of own.txt' }] })
    expect(await call('git_diff', { repo: 'nested' })).toMatchObject({ diff: expect.stringContaining('+changed') })
    expect(await call('git_log', { repo: 'nested' })).toMatchObject({ commits: [{ subject: 'commit of nested.txt' }] })
    expect(await call('git_branch', { repo: 'nested' })).toMatchObject({ branches: [{ name: 'main', current: true }] })
  })
})

// D77 (owner, 2026-10-11): git_diff and git_log judged the repository alone, so git_diff printed a named `.env` under a
// read deny on it and with no sensitive-file ask. Each path they name is now a read of its own, as git_blame's file is.
describe('git_diff and git_log declare a read of each path they name (D77)', () => {
  function workspace() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'git-pack-named-')))
    for (const directory of ['.git', 'secrets', 'sub']) mkdirSync(join(root, directory))
    writeFileSync(join(root, '.env'), 'NAME=placeholder\n')
    return root
  }
  const prepare = (root: string, tool: string, args: Record<string, JsonValue>, mount: string | null = null) => {
    const pack = createGitPack({ paths: createPathView({ root, mount, scratchRoots: [] }), runProcess: vi.fn(), stateDirectory: mkdtempSync(join(tmpdir(), 'git-pack-state-')), git: { path: 'git', argv0: 'git', args: [] } })
    return pack.tools.find(candidate => candidate.capability.name === tool)!.prepare(args)
  }
  /** The verdict the node's own rules give the call, in the node's order, with one filesystem rule. */
  async function verdict(root: string, tool: string, args: Record<string, JsonValue>, rule: { path: string; read: FilesystemPermission } | null) {
    const paths = createPathView({ root, mount: null, scratchRoots: [] })
    const effects = await resolveEffects({ effects: prepare(root, tool, args).effects, paths })
    const policy = { ...emptyWorkspacePolicy(), filesystem: { rules: rule ? [rule] : [] } }
    const engine = createPermissionEngine([createSensitivePathRule(), createFilesystemPolicyRule({ root, policy }), createReadScopeRule({ paths })])
    return engine.evaluate({ tool, effects, grants: { subjectsFor: () => [] } })
  }

  it('declares the repository and each path git_diff names, joined to the repository', () => {
    const root = workspace()
    expect(prepare(root, 'git_diff', { repo: 'repo', paths: ['.env', 'sub/../a.txt'] }).effects).toEqual([
      { kind: 'read_path', path: 'repo' }, { kind: 'read_path', path: 'repo/.env' }, { kind: 'read_path', path: 'repo/a.txt' },
    ])
    expect(prepare(root, 'git_log', { repo: '.', path: 'secrets/' }).effects).toEqual([{ kind: 'read_path', path: '.' }, { kind: 'read_path', path: 'secrets' }])
    expect(prepare(root, 'git_diff', { repo: '/workspace', paths: ['/workspace/.env'] }, '/workspace').effects).toEqual([{ kind: 'read_path', path: '/workspace' }, { kind: 'read_path', path: '/workspace/.env' }])
  })

  it('refuses git_diff naming .env under a read deny on it', async () => {
    expect(await verdict(workspace(), 'git_diff', { paths: ['.env'] }, { path: '.env', read: 'deny' })).toMatchObject({ kind: 'deny', denial: { rule: 'filesystem_policy' } })
  })

  it('asks for git_diff naming .env under an ask rule, and under the sensitive-file check alone, with the file named', async () => {
    const root = workspace()
    expect(await verdict(root, 'git_diff', { paths: ['.env'] }, { path: '.env', read: 'ask' })).toMatchObject({ kind: 'ask', asks: expect.arrayContaining([expect.objectContaining({ rule: 'filesystem_policy', subject: `read:${join(root, '.env')}` })]) })
    expect(await verdict(root, 'git_diff', { staged: true, paths: ['.env'] }, null)).toMatchObject({ kind: 'ask', asks: [expect.objectContaining({ rule: 'sensitive_path', subject: join(root, '.env') })] })
  })

  it('refuses git_log naming secrets/ under a read deny on that folder, and asks under an ask rule', async () => {
    const root = workspace()
    expect(await verdict(root, 'git_log', { path: 'secrets/' }, { path: 'secrets', read: 'deny' })).toMatchObject({ kind: 'deny', denial: { rule: 'filesystem_policy' } })
    expect(await verdict(root, 'git_log', { path: 'secrets/' }, { path: 'secrets', read: 'ask' })).toMatchObject({ kind: 'ask', asks: [expect.objectContaining({ subject: `read:${join(root, 'secrets')}` })] })
  })

  it.each<[string, Record<string, JsonValue>]>([
    ['git_diff', { repo: 'sub', paths: ['../.env'] }],
    ['git_diff', { paths: ['a.txt', '../outside.txt'] }],
    ['git_diff', { paths: ['/etc/hosts'] }],
    ['git_log', { repo: 'sub', path: '..' }],
    ['git_blame', { repo: 'sub', path: '../.env' }],
  ])('refuses %s naming a path outside the repository (%j), with a constant reason and before any spawn', async (tool, args) => {
    const root = workspace()
    const { call, runProcess } = gitPack(root)
    const refusal = await refusalOf(() => call(tool, args))
    expect(refusal).toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining('a path outside the repository') })
    expect(String(refusal)).not.toContain(root)
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('refuses a named link that lands outside the root and every mount, before any spawn', async () => {
    const root = workspace()
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'git-pack-elsewhere-')))
    symlinkSync(join(outside, 'kept.txt'), join(root, 'kept.txt'))
    const { call, runProcess } = gitPack(root)
    const calls: Array<[string, Record<string, JsonValue>]> = [['git_diff', { paths: ['kept.txt'] }], ['git_log', { path: 'kept.txt' }]]
    for (const [tool, args] of calls) {
      const refusal = await refusalOf(() => call(tool, args))
      expect(refusal).toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining('a path outside the repository') })
      expect(String(refusal)).not.toContain(outside)
    }
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('hands git each judged path relative to the repository, read literally rather than as a pattern', async () => {
    const root = workspace()
    const runProcess = answering()
    const { call } = gitPack(root, runProcess)
    await call('git_diff', { paths: ['./sub/../.env', '.en*'] })
    const diff = runProcess.mock.calls.at(-1)![0]
    expect(diff.args.slice(-3)).toEqual(['--', '.env', '.en*'])
    expect(diff.environment).toMatchObject({ GIT_LITERAL_PATHSPECS: '1' })
  })

  it('declares the repository alone for git_diff with no paths, and runs as it did', async () => {
    const root = workspace()
    expect(prepare(root, 'git_diff', {}).effects).toEqual([{ kind: 'read_path', path: '.' }])
    const runProcess = answering()
    const { call } = gitPack(root, runProcess)
    await call('git_diff', {})
    expect(runProcess.mock.calls.at(-1)![0].args.slice(1)).toEqual(['--unified=3', '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all'])
  })
})

describe.skipIf(hostGit === null)('git_diff reads the paths it names literally, against the installed git', () => {
  it('prints no .env change for a pattern that would match it, and the change for the file named', async () => {
    const quiet = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, env: quiet, stdio: 'pipe' })
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'git-pack-literal-')))
    writeFileSync(join(root, '.env'), 'NAME=first\n')
    git(root, 'init', '-q')
    git(root, 'add', '.env')
    git(root, 'commit', '-qm', 'seed')
    writeFileSync(join(root, '.env'), 'NAME=second\n')
    const { call } = gitPack(root, hostRunProcess, null, hostGit!)
    expect(await call('git_diff', { paths: ['.en*'] })).toEqual({ diff: '' })
    expect(await call('git_diff', { paths: ['.env'] })).toMatchObject({ diff: expect.stringContaining('+NAME=second') })
  })
})

// A known limit, kept on purpose (D77 read beside BUCKLE-D17, which declined a per-path gate on git_diff): a diff or log
// naming no path is judged by the repository alone and shows every tracked file, a `.env` included. Buckle adds no
// `:(exclude)` pathspec, as a filtered diff would misreport the tree (docs/known-limits-02.md).
describe.skipIf(hostGit === null)('a git_diff or git_log naming no path reads the whole tree, against the installed git', () => {
  it('shows a tracked .env change unstaged and staged, and lists its commit, with no pathspec added', async () => {
    const quiet = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, env: quiet, stdio: 'pipe' })
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'git-pack-whole-')))
    writeFileSync(join(root, '.env'), 'NAME=first\n')
    git(root, 'init', '-q')
    git(root, 'add', '.env')
    git(root, 'commit', '-qm', 'seed')
    writeFileSync(join(root, '.env'), 'NAME=second\n')
    const requests: Parameters<ProcessRunner>[0][] = []
    const { call } = gitPack(root, request => { requests.push(request); return hostRunProcess(request) }, null, hostGit!)
    expect(await call('git_diff', {})).toMatchObject({ diff: expect.stringContaining('+NAME=second') })
    git(root, 'add', '.env')
    expect(await call('git_diff', { staged: true })).toMatchObject({ diff: expect.stringContaining('+NAME=second') })
    expect(await call('git_log', {})).toMatchObject({ commits: [{ subject: 'seed' }] })
    expect(requests.flatMap(request => request.args).filter(word => word === '--' || word.startsWith(':('))).toEqual([])
  })
})

// D77 (owner, 2026-10-11), the rev-parse race: the repository query and the command were two spawns, and the command found
// its repository again by itself, so a `.git` swapped between them (a `gitdir:` file, or a link) pointed it elsewhere.
describe('a git tool runs against the directories its repository query resolved (D77, the rev-parse race)', () => {
  const PINNED = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'] as const
  function repositories() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'git-pack-race-')))
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'git-pack-race-outside-')))
    mkdirSync(join(root, 'repo', '.git'), { recursive: true })
    mkdirSync(join(outside, '.git'))
    return { root, repo: join(root, 'repo'), outside }
  }
  /** A git that answers the query as a repository with its own `.git`, or with the places named, then runs `during` at the step named. */
  function racing(during: { query?: () => void; config?: () => void; command?: () => void } = {}, places?: string[]) {
    return vi.fn<ProcessRunner>(async request => {
      const answer = (stdout: string, exitCode = 0) => ({ exitCode, signal: null, stderr: '', truncated: false, timedOut: false, stdout })
      if (request.args[0] === 'rev-parse') {
        during.query?.()
        return answer(places ? `${places.join('\n')}\n` : `${request.cwd}\n${request.cwd}/.git\n${request.cwd}/.git\n`)
      }
      if (request.args[0] === 'config') {
        during.config?.()
        return answer('', 1)
      }
      during.command?.()
      return answer('# branch.head main\n1 .M N... 100644 100644 100644 0 0 seen-through-the-swap.txt\n')
    })
  }
  const commandOf = (runProcess: ReturnType<typeof racing>) => runProcess.mock.calls.map(([request]) => request).filter(request => request.args[0] === 'status')
  const pointOutside = (repo: string, outside: string) => () => {
    renameSync(join(repo, '.git'), join(repo, 'moved-git'))
    writeFileSync(join(repo, '.git'), `gitdir: ${join(outside, '.git')}\n`)
  }
  const linkOutside = (repo: string, outside: string) => () => {
    renameSync(join(repo, '.git'), join(repo, 'moved-git'))
    symlinkSync(join(outside, '.git'), join(repo, '.git'))
  }

  it('hands the config listing and the command the resolved git directory, work tree, and common directory, and the query none', async () => {
    const { root, repo } = repositories()
    const runProcess = racing()
    const { call } = gitPack(root, runProcess)
    await call('git_status', { repo: 'repo' })
    const [query, ...rest] = runProcess.mock.calls.map(([request]) => request)
    for (const name of PINNED) expect(query!.environment).not.toHaveProperty(name)
    expect(rest.map(request => request.args[0])).toEqual(['config', 'status'])
    for (const request of rest) expect(request.environment).toMatchObject({ GIT_DIR: `${repo}/.git/.`, GIT_WORK_TREE: repo, GIT_COMMON_DIR: `${repo}/.git/.` })
  })

  // A link swapped in before the query is checked already meets the boundary check; after it, only the pinning sees it.
  it.each([
    ['a gitdir: file', 'query', pointOutside],
    ['a gitdir: file', 'config', pointOutside],
    ['a link', 'config', linkOutside],
  ] as const)('refuses, running no command, when .git is swapped for %s outside the root at the %s step', async (_, step, swap) => {
    const { root, repo, outside } = repositories()
    const runProcess = racing({ [step]: swap(repo, outside) })
    const { call } = gitPack(root, runProcess)
    const refusal = await refusalOf(() => call('git_status', { repo: 'repo' }))
    expect(refusal).toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining('changed while Buckle checked it') })
    expect(String(refusal)).not.toContain(root)
    expect(String(refusal)).not.toContain(outside)
    expect(commandOf(runProcess)).toEqual([])
  })

  // A folder above a pinned place that became a file made the identity check throw ENOTDIR, a plain error in place of the
  // constant refusal (review 1 of the git pack, held[1]).
  it('refuses with the constant reason when the main .git under a pinned linked worktree becomes a file', async () => {
    const { root } = repositories()
    const main = join(root, 'main', '.git')
    mkdirSync(join(main, 'worktrees', 'side'), { recursive: true })
    mkdirSync(join(root, 'side'))
    const swap = () => {
      renameSync(main, join(root, 'main', 'moved-git'))
      writeFileSync(main, 'gitdir: elsewhere\n')
    }
    const runProcess = racing({ config: swap }, [join(root, 'side'), join(main, 'worktrees', 'side'), main])
    const refusal = await refusalOf(() => gitPack(root, runProcess).call('git_status', { repo: 'side' }))
    expect(refusal).toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining('changed while Buckle checked it') })
    expect(String(refusal)).not.toContain(root)
    expect(commandOf(runProcess)).toEqual([])
  })

  // Each pinned place is checked by its real path and identity alone, so each needs a row of its own: the folder above
  // the repository moved under a link to its original keeps its identity, and a separate work tree, or a common
  // directory the git directory does not lie under, is no ancestor of another pinned place (git pack recheck 3, held[4]).
  it.each<[string, string, (root: string, outside: string) => { places: string[]; swap: () => void }]>([
    ['the folder above the repository, swapped for a link to its renamed original', 'outer/repo', root => {
      mkdirSync(join(root, 'outer', 'repo', '.git'), { recursive: true })
      const repo = join(root, 'outer', 'repo')
      return { places: [repo, join(repo, '.git'), join(repo, '.git')], swap: () => { renameSync(join(root, 'outer'), join(root, 'moved-outer')); symlinkSync(join(root, 'moved-outer'), join(root, 'outer')) } }
    }],
    ['a separate work tree, swapped for a link to a folder outside', 'repo', (root, outside) => {
      mkdirSync(join(root, 'work'))
      return { places: [join(root, 'work'), join(root, 'repo', '.git'), join(root, 'repo', '.git')], swap: () => { renameSync(join(root, 'work'), join(root, 'moved-work')); symlinkSync(outside, join(root, 'work')) } }
    }],
    ['a common directory the git directory does not lie under, swapped for a link to a folder outside', 'side', (root, outside) => {
      for (const directory of ['side', 'side-git', join('main', '.git')]) mkdirSync(join(root, directory), { recursive: true })
      return { places: [join(root, 'side'), join(root, 'side-git'), join(root, 'main', '.git')], swap: () => { renameSync(join(root, 'main', '.git'), join(root, 'main', 'moved-git')); symlinkSync(outside, join(root, 'main', '.git')) } }
    }],
  ])('refuses with the constant reason, running no command, when %s at the config step', async (_, repo, layout) => {
    const { root, outside } = repositories()
    const { places, swap } = layout(root, outside)
    const runProcess = racing({ config: swap }, places)
    const refusal = await refusalOf(() => gitPack(root, runProcess).call('git_status', { repo }))
    expect(refusal).toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining('changed while Buckle checked it') })
    expect(String(refusal)).not.toContain(root)
    expect(commandOf(runProcess)).toEqual([])
  })

  it('refuses with the constant reason when the repository folder itself becomes a file', async () => {
    const { root, repo } = repositories()
    const swap = () => {
      renameSync(repo, join(root, 'moved-repo'))
      writeFileSync(repo, 'a file now\n')
    }
    const runProcess = racing({ config: swap })
    const refusal = await refusalOf(() => gitPack(root, runProcess).call('git_status', { repo: 'repo' }))
    expect(refusal).toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining('changed while Buckle checked it') })
    expect(String(refusal)).not.toContain(root)
    expect(commandOf(runProcess)).toEqual([])
  })

  it('refuses, showing nothing git printed, when .git is swapped while the command runs', async () => {
    const { root, repo, outside } = repositories()
    const runProcess = racing({ command: pointOutside(repo, outside) })
    const { call } = gitPack(root, runProcess)
    const refusal = await refusalOf(() => call('git_status', { repo: 'repo' }))
    expect(refusal).toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(String(refusal)).not.toContain('seen-through-the-swap')
    expect(commandOf(runProcess)).toHaveLength(1)
  })

  it('never hands git a repository, object, or config variable from its caller, only its own', async () => {
    const { root, repo } = repositories()
    const runProcess = racing()
    const elsewhere = '/elsewhere'
    const caller: HostEnvironment = extra => ({
      PATH: '/usr/bin', GIT_DIR: elsewhere, GIT_WORK_TREE: elsewhere, GIT_OBJECT_DIRECTORY: elsewhere, GIT_ALTERNATE_OBJECT_DIRECTORIES: elsewhere,
      GIT_COMMON_DIR: elsewhere, GIT_CONFIG_GLOBAL: elsewhere, GIT_CONFIG_SYSTEM: elsewhere, GIT_CEILING_DIRECTORIES: elsewhere, GIT_INDEX_FILE: elsewhere, ...extra,
    })
    const pack = createGitPack({ paths: createPathView({ root, mount: null, scratchRoots: [] }), runProcess, stateDirectory: mkdtempSync(join(tmpdir(), 'git-pack-state-')), git: { path: 'git', argv0: 'git', args: [] }, environment: caller })
    await pack.tools.find(tool => tool.capability.name === 'git_status')!.prepare({ repo: 'repo' }).execute({ requestId: 'req-1', sessionId: 'chat-1', timeoutMs: 1_000, signal: AbortSignal.timeout(1_000) })
    const requests: ProcessRequest[] = runProcess.mock.calls.map(([request]) => request)
    expect(requests).toHaveLength(3)
    for (const request of requests) {
      expect(Object.values(request.environment ?? {})).not.toContain(elsewhere)
      expect(request.environment).toMatchObject({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' })
      for (const name of ['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_SYSTEM', 'GIT_INDEX_FILE']) expect(request.environment).not.toHaveProperty(name)
    }
    expect(requests[0]!.environment).toMatchObject({ GIT_CEILING_DIRECTORIES: parentOf(root) })
    expect(requests[2]!.environment).toMatchObject({ GIT_DIR: `${repo}/.git/.`, GIT_WORK_TREE: repo })
  })
})

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/'
}

describe.skipIf(hostGit === null)('a git tool pinned to the resolved directories, against the installed git', () => {
  it('still reads a linked worktree inside the workspace, from its root and a folder in it', async () => {
    const quiet = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, env: quiet, stdio: 'pipe' })
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'git-pack-worktree-')))
    mkdirSync(join(root, 'main', 'src'), { recursive: true })
    writeFileSync(join(root, 'main', 'src', 'a.txt'), 'first\n')
    git(join(root, 'main'), 'init', '-q')
    git(join(root, 'main'), 'add', '.')
    git(join(root, 'main'), 'commit', '-qm', 'seed')
    git(join(root, 'main'), 'worktree', 'add', '-q', '-b', 'side', join(root, 'side'))
    writeFileSync(join(root, 'side', 'src', 'a.txt'), 'second\n')
    const { call } = gitPack(root, hostRunProcess, null, hostGit!)
    expect(await call('git_status', { repo: 'side' })).toMatchObject({ branch: 'side', entries: [{ state: '.M', path: 'src/a.txt' }] })
    expect(await call('git_diff', { repo: 'side/src', paths: ['a.txt'] })).toMatchObject({ diff: expect.stringContaining('+second') })
    expect(await call('git_log', { repo: 'side/src' })).toMatchObject({ commits: [{ subject: 'seed' }] })
  })

  it('refuses when .git becomes a gitdir: file outside the root just before git runs, showing nothing of that repository', async () => {
    const quiet = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, env: quiet, stdio: 'pipe' })
    const seeded = (directory: string, subject: string) => {
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'a.txt'), `${subject}\n`)
      git(directory, 'init', '-q')
      git(directory, 'add', 'a.txt')
      git(directory, 'commit', '-qm', subject)
    }
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'git-pack-live-race-')))
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'git-pack-live-race-outside-')))
    seeded(root, 'inside')
    seeded(outside, 'history kept elsewhere')
    const swapping: ProcessRunner = request => {
      if (request.args[0] === 'log') {
        renameSync(join(root, '.git'), join(root, 'moved-git'))
        writeFileSync(join(root, '.git'), `gitdir: ${join(outside, '.git')}\n`)
      }
      return hostRunProcess(request)
    }
    const { call } = gitPack(root, swapping, null, hostGit!)
    const refusal = await refusalOf(() => call('git_log', {}))
    expect(refusal).toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(String(refusal)).not.toMatch(/history kept elsewhere|git-pack-live-race/)
  })
})

// D77 (owner, 2026-10-11), objects/info/alternates: a repository inside the root can borrow its objects from a store
// anywhere, which git then reads as the repository's own history, with no permission check on that place.
describe('a git tool refuses a repository that borrows objects from outside the workspace (D77, alternates)', () => {
  const BORROWS = 'borrows objects from outside the workspace'
  function workspace() {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'git-pack-alternates-')))
    const root = join(parent, 'root')
    const outside = join(parent, 'elsewhere')
    for (const directory of [join(root, 'repo', '.git', 'objects', 'info'), join(root, 'shared', 'info'), join(outside, 'info')]) mkdirSync(directory, { recursive: true })
    return { root, repo: join(root, 'repo'), outside }
  }
  const alternates = (store: string, ...lines: string[]) => writeFileSync(join(store, 'info', 'alternates'), `${lines.join('\n')}\n`)
  /** A git that answers the query with the places named, and runs `during` when the command runs. */
  function answeringAt(places: { workTree: string; gitDirectory: string; commonDirectory: string }, during?: () => void) {
    return vi.fn<ProcessRunner>(async request => {
      const answer = (stdout: string, exitCode = 0) => ({ exitCode, signal: null, stderr: '', truncated: false, timedOut: false, stdout })
      if (request.args[0] === 'rev-parse') return answer(`${places.workTree}\n${places.gitDirectory}\n${places.commonDirectory}\n`)
      if (request.args[0] === 'config') return answer('', 1)
      during?.()
      return answer('borrowed-commit\x1fsomeone\x1f2026-10-20T00:00:00Z\x1fa subject from the borrowed store\n')
    })
  }
  const plain = (repo: string) => ({ workTree: repo, gitDirectory: join(repo, '.git'), commonDirectory: join(repo, '.git') })
  const logOf = (runProcess: ReturnType<typeof answeringAt>) => runProcess.mock.calls.filter(([request]) => request.args[0] === 'log')
  async function refused(root: string, runProcess: ReturnType<typeof answeringAt>, outside: string) {
    const { call } = gitPack(root, runProcess)
    const refusal = await refusalOf(() => call('git_log', { repo: 'repo' }))
    expect(refusal).toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining(BORROWS) })
    expect(String(refusal)).not.toContain(outside)
    expect(String(refusal)).not.toContain('a subject from the borrowed store')
  }

  it('runs with no alternates file, the normal case, and with one naming a store inside the workspace', async () => {
    const { root, repo } = workspace()
    const runProcess = answeringAt(plain(repo))
    const { call } = gitPack(root, runProcess)
    await call('git_log', { repo: 'repo' })
    alternates(join(repo, '.git', 'objects'), join(root, 'shared'), '# a comment', '')
    await call('git_log', { repo: 'repo' })
    expect(logOf(runProcess)).toHaveLength(2)
  })

  it('refuses one naming a store outside, after the query and before any other spawn', async () => {
    const { root, repo, outside } = workspace()
    alternates(join(repo, '.git', 'objects'), outside)
    const runProcess = answeringAt(plain(repo))
    await refused(root, runProcess, outside)
    expect(runProcess.mock.calls.map(([request]) => request.args[0])).toEqual(['rev-parse'])
  })

  it('reads a relative line from the objects folder: one landing inside runs, one landing outside refuses', async () => {
    const { root, repo, outside } = workspace()
    // From repo/.git/objects, three levels up is the root: inside when read from objects/, outside when read from .git/.
    alternates(join(repo, '.git', 'objects'), '../../../shared')
    const inside = answeringAt(plain(repo))
    await gitPack(root, inside).call('git_log', { repo: 'repo' })
    expect(logOf(inside)).toHaveLength(1)
    alternates(join(repo, '.git', 'objects'), '../../../../elsewhere')
    await refused(root, answeringAt(plain(repo)), outside)
  })

  it('refuses a quoted line naming a store outside, and a store inside that borrows from one outside in turn', async () => {
    const { root, repo, outside } = workspace()
    alternates(join(repo, '.git', 'objects'), `"${outside}"`)
    await refused(root, answeringAt(plain(repo)), outside)
    alternates(join(repo, '.git', 'objects'), join(root, 'shared'))
    alternates(join(root, 'shared'), outside)
    await refused(root, answeringAt(plain(repo)), outside)
  })

  it('reads a linked worktree\'s common directory, and refuses an objects folder that is a link outside', async () => {
    const { root, repo, outside } = workspace()
    mkdirSync(join(repo, '.git', 'worktrees', 'side'), { recursive: true })
    mkdirSync(join(root, 'side'))
    alternates(join(repo, '.git', 'objects'), outside)
    await refused(root, answeringAt({ workTree: join(root, 'side'), gitDirectory: join(repo, '.git', 'worktrees', 'side'), commonDirectory: join(repo, '.git') }), outside)
    alternates(join(repo, '.git', 'objects'), '')
    renameSync(join(repo, '.git', 'objects'), join(repo, 'kept-objects'))
    symlinkSync(outside, join(repo, '.git', 'objects'))
    await refused(root, answeringAt(plain(repo)), outside)
  })

  it('refuses, showing nothing git printed, an alternates file written while the command runs', async () => {
    const { root, repo, outside } = workspace()
    await refused(root, answeringAt(plain(repo), () => alternates(join(repo, '.git', 'objects'), outside)), outside)
  })

  // git unquotes a line into bytes and opens the bytes: a line read as text named another place than the one git opens,
  // which did not exist, so it was taken as inside while git followed a link there (review 1 of the git pack, held[0]).
  it('reads a quoted line as the bytes git reads: an e-acute written as octal escapes is the folder of that name', async () => {
    const { root, repo, outside } = workspace()
    mkdirSync(join(root, 'é'))
    alternates(join(repo, '.git', 'objects'), `"${root}/\\303\\251"`)
    const inside = answeringAt(plain(repo))
    await gitPack(root, inside).call('git_log', { repo: 'repo' })
    expect(logOf(inside)).toHaveLength(1)
    rmdirSync(join(root, 'é'))
    symlinkSync(outside, join(root, 'é'))
    await refused(root, answeringAt(plain(repo)), outside)
  })

  it.skipIf(process.platform !== 'linux')('checks a store named by bytes that are not UTF-8 where git reads it, written raw or quoted', async () => {
    const { root, repo, outside } = workspace()
    const objects = join(repo, '.git', 'objects')
    const name = Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0xe9])])
    mkdirSync(name)
    writeFileSync(join(objects, 'info', 'alternates'), Buffer.concat([name, Buffer.from('\n')]))
    const inside = answeringAt(plain(repo))
    await gitPack(root, inside).call('git_log', { repo: 'repo' })
    expect(logOf(inside)).toHaveLength(1)
    rmdirSync(name)
    symlinkSync(outside, name)
    await refused(root, answeringAt(plain(repo)), outside)
    alternates(objects, `"${root}/\\351"`)
    await refused(root, answeringAt(plain(repo)), outside)
  })

  // repositoryBoundary still reaches a repository outside the workspace that a read approval judged, and the objects
  // check, which read only the workspace's roots, refused it as borrowing with no alternates file at all (review 1 of
  // the git pack, held[10]).
  it('runs a read-approved repository outside the workspace, its own stores included, and refuses one borrowing from outside it', async () => {
    const { root, outside } = workspace()
    const approved = join(dirname(root), 'approved')
    for (const directory of [join(approved, '.git', 'objects', 'info'), join(approved, 'store', 'info')]) mkdirSync(directory, { recursive: true })
    const judged = { authorizeReadTarget: (target: string) => target === approved }
    const runs = answeringAt(plain(approved))
    await gitPack(root, runs).call('git_log', { repo: approved }, judged)
    alternates(join(approved, '.git', 'objects'), join(approved, 'store'))
    await gitPack(root, runs).call('git_log', { repo: approved }, judged)
    expect(logOf(runs)).toHaveLength(2)
    alternates(join(approved, '.git', 'objects'), outside)
    const refusal = await refusalOf(() => gitPack(root, answeringAt(plain(approved))).call('git_log', { repo: approved }, judged))
    expect(refusal).toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining(BORROWS) })
    expect(String(refusal)).not.toContain(outside)
  })

  it('refuses a line whose quoting is broken, even one naming a store inside', async () => {
    const { root, repo, outside } = workspace()
    for (const line of [`"${join(root, 'shared')}`, `"${join(root, 'shared')}\\q"`, `"${join(root, 'shared')}"trailing`]) {
      alternates(join(repo, '.git', 'objects'), line)
      await refused(root, answeringAt(plain(repo)), outside)
    }
  })

  // git reads a line by its real path, so a `..` after a link climbs from where the link points, while the check folded
  // the line as text first: `<root>/link/..`, the link leading to a folder outside, borrowed from outside with no
  // refusal (git pack recheck 2, held[2]). git climbs out of a link to a file too, where the system refuses to. Each
  // line is written as text, never joined, which would fold it; `<root>` stands for the root.
  it.each([['<root>/link/..'], ['<root>/link/../'], ['../../../link/..'], ['<root>/file-link/..'], ['../../../file-link/..']])('refuses the line %s, whose `..` climbs out of a link to a folder or a file outside', async line => {
    const { root, repo, outside } = workspace()
    writeFileSync(join(outside, 'HEAD'), 'ref: refs/heads/main\n')
    symlinkSync(join(outside, 'info'), join(root, 'link'))
    symlinkSync(join(outside, 'HEAD'), join(root, 'file-link'))
    alternates(join(repo, '.git', 'objects'), line.replace('<root>', root))
    await refused(root, answeringAt(plain(repo)), outside)
  })

  it.each([['a plain line inside', '<root>/shared'], ['a `..` after a link that stays inside', '<root>/inside-link/..'], ['the same, relative', '../../../inside-link/..'], ['a line git cannot normalize, its text inside', '<root>/nonexistent/../store/.git/objects'], ['a store not made yet, inside', '<root>/later']])('runs %s, as before: %s', async (_, line) => {
    const { root, repo } = workspace()
    symlinkSync(join(root, 'shared', 'info'), join(root, 'inside-link'))
    mkdirSync(join(root, 'store', '.git', 'objects'), { recursive: true })
    alternates(join(repo, '.git', 'objects'), line.replace('<root>', root))
    const runs = answeringAt(plain(repo))
    await gitPack(root, runs).call('git_log', { repo: 'repo' })
    expect(logOf(runs)).toHaveLength(1)
  })

  // A line passes only where it lands inside both as git reads it and folded as text, so a git that folds the line is
  // covered too; the cost is a line inside by its real path but outside as text, refused though git reads inside.
  it.each([['<root>/deep/../../elsewhere'], ['../../../deep/../../elsewhere']])('refuses the line %s, inside by its real path but outside folded as text', async line => {
    const { root, repo, outside } = workspace()
    mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true })
    mkdirSync(join(root, 'a', 'elsewhere', 'info'), { recursive: true })
    symlinkSync(join(root, 'a', 'b', 'c'), join(root, 'deep'))
    alternates(join(repo, '.git', 'objects'), line.replace('<root>', root))
    await refused(root, answeringAt(plain(repo)), outside)
  })

  // git climbs out of a file with `..` where the system refuses to, so the two answers differ even inside the root.
  it('refuses a line whose `..` climbs out of a file inside the root, where the system\'s real path is not git\'s', async () => {
    const { root, repo, outside } = workspace()
    writeFileSync(join(root, 'shared', 'HEAD'), 'ref: refs/heads/main\n')
    symlinkSync(join(root, 'shared', 'HEAD'), join(root, 'inside-file-link'))
    alternates(join(repo, '.git', 'objects'), `${root}/inside-file-link/..`)
    const refusal = await refusalOf(() => gitPack(root, answeringAt(plain(repo))).call('git_log', { repo: 'repo' }))
    expect(refusal).toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining('cannot resolve as git does') })
    expect(String(refusal)).not.toContain(outside)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('refuses a line through a folder it cannot search, with the constant reason', async () => {
    const { root, repo } = workspace()
    mkdirSync(join(root, 'locked', 'store'), { recursive: true })
    chmodSync(join(root, 'locked'), 0o000)
    try {
      alternates(join(repo, '.git', 'objects'), join(root, 'locked', 'store'))
      const refusal = await refusalOf(() => gitPack(root, answeringAt(plain(repo))).call('git_log', { repo: 'repo' }))
      expect(refusal).toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining('cannot resolve as git does') })
      expect(String(refusal)).not.toContain(root)
    } finally { chmodSync(join(root, 'locked'), 0o755) }
  })

  // Which constant reason a refusal carries depends on where the walk reached, never on whether it could finish. Outside
  // every root, a line the walk could not finish (an earlier name absent, a file in the middle, a folder the node cannot
  // search) was told from one that landed, so the reason was one bit of the host file system per call, with no path in
  // it (git pack recheck 4, held[2]). Inside a root the wording stays.
  describe('the reason for a line the walk cannot finish', () => {
    /** The message the call is refused with for `line`, read as text with `<outside>` and `<root>` filled in. */
    async function messageFor(places: { root: string; repo: string; outside: string }, line: string): Promise<string> {
      alternates(join(places.repo, '.git', 'objects'), line.replace('<outside>', places.outside).replace('<root>', places.root))
      const refusal = await refusalOf(() => gitPack(places.root, answeringAt(plain(places.repo))).call('git_log', { repo: 'repo' }))
      expect(refusal).toMatchObject({ code: 'PERMISSION_DENIED' })
      return (refusal as Error).message
    }
    function places() {
      const made = workspace()
      mkdirSync(join(made.outside, 'existingdir'))
      writeFileSync(join(made.outside, 'file'), 'not a folder\n')
      mkdirSync(join(made.outside, 'locked', 'store'), { recursive: true })
      writeFileSync(join(made.root, 'shared', 'HEAD'), 'ref: refs/heads/main\n')
      return made
    }

    it.each([
      ['an earlier name absent', '<outside>/nosuchdir/zzz'],
      ['an earlier name absent, written relative', '../../../../elsewhere/nosuchdir/zzz'],
      ['an existing folder with the last name absent', '<outside>/existingdir/zzz'],
      ['a file in the middle', '<outside>/file/zzz'],
    ])('outside every root, %s, is refused as a plain outside line is', async (_, line) => {
      const made = places()
      const plainOutside = await messageFor(made, '<outside>')
      expect(plainOutside).toContain(BORROWS)
      const message = await messageFor(made, line)
      expect(message).toBe(plainOutside)
      expect(message).not.toContain(made.outside)
    })

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('outside every root, a folder the node cannot search is refused as a plain outside line is', async () => {
      const made = places()
      const plainOutside = await messageFor(made, '<outside>')
      chmodSync(join(made.outside, 'locked'), 0o000)
      try { expect(await messageFor(made, '<outside>/locked/store')).toBe(plainOutside) } finally { chmodSync(join(made.outside, 'locked'), 0o755) }
    })

    it('inside a root, a file in the middle keeps the reason that names a place Buckle cannot resolve as git does', async () => {
      const made = places()
      expect(await messageFor(made, '<root>/shared/HEAD/sub')).toContain('cannot resolve as git does')
    })
  })

  // Each row below fails with its guard reverted (git pack recheck 3, held[4]).
  it.each([['absolute', '<root>-sibling/objects'], ['relative', '../../../../root-sibling/objects']])('refuses a store in a sibling folder whose name starts with the root\'s, written %s', async (_, line) => {
    const { root, repo, outside } = workspace()
    mkdirSync(join(`${root}-sibling`, 'objects', 'info'), { recursive: true })
    alternates(join(repo, '.git', 'objects'), line.replace('<root>', root))
    await refused(root, answeringAt(plain(repo)), outside)
  })

  // The objects folder and five stores below it are six levels, as deep as git reads alternates.
  it.each([['three', ['s1', 's2']], ['six', ['s1', 's2', 's3', 's4', 's5']]])('refuses a chain of %s stores whose last borrows from outside', async (_, names) => {
    const { root, repo, outside } = workspace()
    for (const name of names) mkdirSync(join(root, name, 'info'), { recursive: true })
    alternates(join(repo, '.git', 'objects'), join(root, names[0]!))
    names.forEach((name, index) => alternates(join(root, name), index === names.length - 1 ? outside : join(root, names[index + 1]!)))
    await refused(root, answeringAt(plain(repo)), outside)
  })

  it('refuses a 70 KiB alternates file, though it names only a store inside', async () => {
    const { root, repo, outside } = workspace()
    alternates(join(repo, '.git', 'objects'), `# ${'x'.repeat(70 * 1024)}`, join(root, 'shared'))
    await refused(root, answeringAt(plain(repo)), outside)
  })

  it('refuses an alternates file that is a link to a device', async () => {
    const { root, repo, outside } = workspace()
    symlinkSync('/dev/null', join(repo, '.git', 'objects', 'info', 'alternates'))
    await refused(root, answeringAt(plain(repo)), outside)
  })

  // After the two rows above, so a regression that reads the pipe fails there before this one hangs.
  it.skipIf(process.platform === 'win32')('refuses an alternates file that is a named pipe, without reading it', async () => {
    const { root, repo, outside } = workspace()
    execFileSync('mkfifo', [join(repo, '.git', 'objects', 'info', 'alternates')])
    await refused(root, answeringAt(plain(repo)), outside)
  })

  it('reads a comment line as a comment, even one whose text would climb outside, and runs with the store inside', async () => {
    const { root, repo } = workspace()
    alternates(join(repo, '.git', 'objects'), '#/../../../../../elsewhere', join(root, 'shared'))
    const runs = answeringAt(plain(repo))
    await gitPack(root, runs).call('git_log', { repo: 'repo' })
    expect(logOf(runs)).toHaveLength(1)
  })

  it('refuses a line holding a backslash off Windows, even naming a folder inside by that name', async () => {
    const { root, repo, outside } = workspace()
    mkdirSync(join(root, 'sha\\red'))
    alternates(join(repo, '.git', 'objects'), join(root, 'sha\\red'))
    await refused(root, answeringAt(plain(repo)), outside)
  })

  // Stores each naming every other held the node's single thread for seconds, three times a call, and one file of 32,768
  // short lines for as long: a check reads at most 32 stores, counts at most 256 lines before resolving any, and walks at
  // most 8,192 names (git pack recheck 3, held[1]).
  describe('within what one check reads', () => {
    const TOO_MANY = 'more stores, or through longer paths, than Buckle checks'
    /** The refusal, with the system's real path asked at most as often as 256 lines resolved three ways in three checks. */
    async function refusedCheaply(root: string, repo: string) {
      const native = vi.spyOn(realpathSync, 'native')
      try {
        const refusal = await refusalOf(() => gitPack(root, answeringAt(plain(repo))).call('git_log', { repo: 'repo' }))
        expect(refusal).toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining(TOO_MANY) })
        expect(String(refusal)).not.toContain(root)
        expect(native.mock.calls.length).toBeLessThanOrEqual(256 * 3 * 3)
      } finally { native.mockRestore() }
    }

    it('refuses 70 stores, each named by the repository and each naming the next', async () => {
      const { root, repo } = workspace()
      const stores = Array.from({ length: 70 }, (_, index) => join(root, 'stores', String(index)))
      for (const store of stores) mkdirSync(join(store, 'info'), { recursive: true })
      stores.forEach((store, index) => { if (index < stores.length - 1) alternates(store, stores[index + 1]!) })
      alternates(join(repo, '.git', 'objects'), ...stores)
      await refusedCheaply(root, repo)
    })

    it('refuses one alternates file of 32,768 lines of `.`, at its 64 KiB cap', async () => {
      const { root, repo } = workspace()
      writeFileSync(join(repo, '.git', 'objects', 'info', 'alternates'), '.\n'.repeat(32_768))
      await refusedCheaply(root, repo)
    })

    it('refuses a line through 40 links, each holding long runs of `..`, past the names one check walks', async () => {
      const { root, repo } = workspace()
      mkdirSync(join(root, 'x'))
      // Short targets, as some file systems hold a link of at most 1 KiB.
      for (let index = 0; index < 40; index++) symlinkSync(`${'x/../'.repeat(190)}${index === 39 ? 'shared' : `hop-${index + 1}`}`, join(root, `hop-${index}`))
      alternates(join(repo, '.git', 'objects'), join(root, 'hop-0'))
      await refusedCheaply(root, repo)
    })

    it('runs at the caps and refuses one past each: 31 stores named, then 32, and 256 lines, then 257', async () => {
      const { root, repo } = workspace()
      const stores = Array.from({ length: 32 }, (_, index) => join(root, 'stores', String(index)))
      for (const store of stores) mkdirSync(join(store, 'info'), { recursive: true })
      const runs = answeringAt(plain(repo))
      for (const [lines, outcome] of [[stores.slice(0, 31), 'runs'], [stores, 'refused'], [Array(256).fill('.'), 'runs'], [Array(257).fill('.'), 'refused']] as const) {
        alternates(join(repo, '.git', 'objects'), ...lines)
        const refusal = await refusalOf(() => gitPack(root, runs).call('git_log', { repo: 'repo' }))
        if (outcome === 'runs') expect(refusal).toBeNull()
        else expect(refusal).toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining(TOO_MANY) })
      }
      expect(logOf(runs)).toHaveLength(2)
    })

    it.each([1, 2, 3])('runs a repository borrowing from %i stores inside', async count => {
      const { root, repo } = workspace()
      const stores = Array.from({ length: count }, (_, index) => join(root, 'stores', String(index)))
      for (const store of stores) mkdirSync(join(store, 'info'), { recursive: true })
      alternates(join(repo, '.git', 'objects'), ...stores)
      const runs = answeringAt(plain(repo))
      await gitPack(root, runs).call('git_log', { repo: 'repo' })
      expect(logOf(runs)).toHaveLength(1)
    })

    // The caps above count; they did not weigh. Each name costs the depth of the path so far (lstat walks every
    // component, the system's real path is quadratic in depth), so one call with a deep path held the node's single
    // thread for 12 to 25 s with every count far under its cap (git pack recheck 4, held[0]). Each name is charged its
    // depth against a second budget, and a repository's own places are charged the same before they are resolved.
    describe.skipIf(process.platform !== 'linux')('within what one check costs', () => {
      const UNITS = 262_144
      const nested = (base: string, levels: number) => {
        const path = join(base, ...Array<string>(levels).fill('a'))
        mkdirSync(path, { recursive: true })
        return path
      }
      /** The names of an absolute path, and what walking it costs: the empty one before the first `/` at one unit, then each at its depth. */
      const namesIn = (path: string) => path.split('/').filter(Boolean).length
      const walkCost = (path: string) => 1 + (namesIn(path) * (namesIn(path) + 1)) / 2
      /** Counts the lstat calls a body makes: the sources import the function by name, so the ESM exports are synced. */
      async function countingLstat<Result>(body: () => Promise<Result>): Promise<{ result: Result; lstats: number }> {
        const fs = nodeFs as unknown as { lstatSync: (...args: unknown[]) => unknown }
        const original = fs.lstatSync
        let lstats = 0
        fs.lstatSync = (...args) => { lstats++; return original(...args) }
        syncBuiltinESMExports()
        try {
          const result = await body()
          return { result, lstats }
        } finally { fs.lstatSync = original; syncBuiltinESMExports() }
      }
      /**
       * A call's refusal, with the walk's lstat calls counted and the system asked for the real path of a place over
       * 500 bytes long at most `resolved` times: the resolver that judges the repository's own folder asks once, the pack none.
       */
      async function refusedBeforeWalkingAll(root: string, repo: string, places: ReturnType<typeof plain>, resolved: number) {
        const native = vi.spyOn(realpathSync, 'native')
        const started = performance.now()
        try {
          const { result: refusal, lstats } = await countingLstat(() => refusalOf(() => gitPack(root, answeringAt(places)).call('git_log', { repo })))
          expect(refusal).toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining(TOO_MANY) })
          expect(String(refusal)).not.toContain(root)
          expect(native.mock.calls.filter(([place]) => String(place).length > 500).length).toBeLessThanOrEqual(resolved)
          expect(lstats).toBeLessThan(1_000)
          expect(performance.now() - started).toBeLessThan(2_000)
        } finally { native.mockRestore() }
      }

      it('refuses a line through 1,800 nested folders, the walk stopped by its cost and the system never asked for its real path', async () => {
        const { root, repo } = workspace()
        alternates(join(repo, '.git', 'objects'), nested(join(root, 'deep'), 1_800))
        await refusedBeforeWalkingAll(root, 'repo', plain(repo), 0)
      })

      it('refuses a repository 1,800 folders deep, its places charged before any is resolved', async () => {
        const { root } = workspace()
        const deep = nested(join(root, 'deep'), 1_800)
        mkdirSync(join(deep, '.git', 'objects', 'info'), { recursive: true })
        await refusedBeforeWalkingAll(root, deep, plain(deep), 1)
      })

      // The query is charged for the places git names; the pins resolve their real ones again and again, so a link to a
      // deep place is charged there. The link's target is short, as some file systems hold one of at most 1 KiB.
      it('refuses a repository that git names by a link to a place 480 folders deep, the pins charged for its real places', async () => {
        const { root } = workspace()
        const deep = nested(join(root, 'deep'), 480)
        mkdirSync(join(deep, '.git', 'objects', 'info'), { recursive: true })
        symlinkSync(deep.slice(root.length + 1), join(root, 'linked'))
        await refusedBeforeWalkingAll(root, 'linked', plain(join(root, 'linked')), 0)
      })

      it.each([300, 6])('still runs a store, and a repository, %i folders deep', async levels => {
        const { root, repo } = workspace()
        const store = nested(join(root, 'store'), levels)
        alternates(join(repo, '.git', 'objects'), store)
        const deep = nested(join(root, 'repository'), levels)
        mkdirSync(join(deep, '.git', 'objects', 'info'), { recursive: true })
        const runs = answeringAt(plain(repo))
        await gitPack(root, runs).call('git_log', { repo: 'repo' })
        const inDeep = answeringAt(plain(deep))
        await gitPack(root, inDeep).call('git_log', { repo: deep })
        expect(logOf(runs)).toHaveLength(1)
        expect(logOf(inDeep)).toHaveLength(1)
      })

      it('runs lines up to the unit cap and refuses one past it, each name charged its depth', async () => {
        const { root, repo } = workspace()
        const store = nested(root, 128 - namesIn(root))
        const objects = join(repo, '.git', 'objects')
        // Each line is walked twice, as git opens it and folded, and the objects folder is walked once.
        const fits = Math.floor((UNITS - walkCost(objects)) / (2 * walkCost(store)))
        expect(fits).toBeGreaterThan(5)
        const runs = answeringAt(plain(repo))
        alternates(objects, ...Array<string>(fits).fill(store))
        await gitPack(root, runs).call('git_log', { repo: 'repo' })
        expect(logOf(runs)).toHaveLength(1)
        alternates(objects, ...Array<string>(fits + 1).fill(store))
        const refusal = await refusalOf(() => gitPack(root, runs).call('git_log', { repo: 'repo' }))
        expect(refusal).toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining(TOO_MANY) })
        expect(logOf(runs)).toHaveLength(1)
      })
    })
  })

  // Each place is walked name by name as git walks it, following as many links as Linux does and no more.
  it('runs a line through a chain of 40 links inside, and refuses one through 41 with the constant reason', async () => {
    const { root, repo, outside } = workspace()
    const chain = (count: number) => {
      for (let index = 0; index < count; index++) symlinkSync(index === count - 1 ? 'shared' : `chain-${count}-${index + 1}`, join(root, `chain-${count}-${index}`))
      return join(root, `chain-${count}-0`)
    }
    alternates(join(repo, '.git', 'objects'), chain(40))
    const runs = answeringAt(plain(repo))
    await gitPack(root, runs).call('git_log', { repo: 'repo' })
    expect(logOf(runs)).toHaveLength(1)
    alternates(join(repo, '.git', 'objects'), chain(41))
    const refusal = await refusalOf(() => gitPack(root, answeringAt(plain(repo))).call('git_log', { repo: 'repo' }))
    expect(refusal).toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining('cannot resolve as git does') })
    expect(String(refusal)).not.toContain(outside)
  })
})

describe.skipIf(hostGit === null)('a repository that borrows objects, against the installed git', () => {
  it('refuses a clone that shares the objects of a repository outside the workspace, and reads one sharing a repository inside', async () => {
    const quiet = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, env: quiet, stdio: 'pipe' })
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'git-pack-shared-')))
    for (const [directory, subject] of [[join(parent, 'elsewhere'), 'history kept elsewhere'], [join(parent, 'root', 'origin'), 'history kept inside']] as const) {
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'a.txt'), `${subject}\n`)
      git(directory, 'init', '-q')
      git(directory, 'add', 'a.txt')
      git(directory, 'commit', '-qm', subject)
    }
    const root = join(parent, 'root')
    git(root, 'clone', '-q', '--shared', join(parent, 'elsewhere'), 'borrowing')
    git(root, 'clone', '-q', '--shared', join(root, 'origin'), 'sharing')
    const { call } = gitPack(root, hostRunProcess, null, hostGit!)
    const refusal = await refusalOf(() => call('git_log', { repo: 'borrowing' }))
    expect(refusal).toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(String(refusal)).not.toMatch(/history kept elsewhere|git-pack-shared/)
    expect(await call('git_log', { repo: 'sharing' })).toMatchObject({ commits: [{ subject: 'history kept inside' }] })
  })

  it('refuses a clone that shares the objects of a sibling folder whose name starts with the root\'s', async () => {
    const quiet = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, env: quiet, stdio: 'pipe' }).toString()
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'git-pack-sibling-')))
    const sibling = join(parent, 'root-sibling')
    mkdirSync(sibling)
    writeFileSync(join(sibling, 'a.txt'), 'history kept in the sibling\n')
    git(sibling, 'init', '-q')
    git(sibling, 'add', 'a.txt')
    git(sibling, 'commit', '-qm', 'history kept in the sibling')
    const root = join(parent, 'root')
    mkdirSync(root)
    git(root, 'clone', '-q', '--shared', sibling, 'borrowing')
    expect(git(join(root, 'borrowing'), 'log', '--format=%s')).toContain('history kept in the sibling')
    const refusal = await refusalOf(() => gitPack(root, hostRunProcess, null, hostGit!).call('git_log', { repo: 'borrowing' }))
    expect(refusal).toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining('borrows objects from outside the workspace') })
    expect(String(refusal)).not.toMatch(/history kept in the sibling|git-pack-sibling/)
  })

  it('reads a repository outside the workspace once a read of it is approved', async () => {
    const quiet = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'git-pack-approved-')))
    const root = join(parent, 'root')
    const approved = join(parent, 'approved')
    for (const directory of [root, approved]) mkdirSync(directory)
    execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: approved, env: quiet, stdio: 'pipe' })
    writeFileSync(join(approved, 'a.txt'), 'kept outside\n')
    const { call } = gitPack(root, hostRunProcess, null, hostGit!)
    expect(await call('git_status', { repo: approved }, { authorizeReadTarget: target => target === approved })).toMatchObject({ branch: 'main', entries: [{ state: 'untracked', path: 'a.txt' }] })
  })

  it.skipIf(process.platform !== 'linux')('refuses a store reached through a name written as octal escapes, or as bytes that are not UTF-8', async () => {
    const quiet = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, env: quiet, stdio: 'pipe' })
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'git-pack-named-store-')))
    const elsewhere = join(parent, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'a.txt'), 'history kept elsewhere\n')
    git(elsewhere, 'init', '-q')
    git(elsewhere, 'add', 'a.txt')
    git(elsewhere, 'commit', '-qm', 'history kept elsewhere')
    const root = join(parent, 'root')
    mkdirSync(root)
    git(root, 'clone', '-q', '--shared', elsewhere, 'borrowing')
    const file = join(root, 'borrowing', '.git', 'objects', 'info', 'alternates')
    const raw = Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0xe9])])
    symlinkSync(join(elsewhere, '.git', 'objects'), join(root, 'é'))
    symlinkSync(join(elsewhere, '.git', 'objects'), raw)
    const { call } = gitPack(root, hostRunProcess, null, hostGit!)
    for (const line of [Buffer.from(`"${root}/\\303\\251"\n`), Buffer.concat([raw, Buffer.from('\n')])]) {
      writeFileSync(file, line)
      expect(execFileSync('git', ['log', '--format=%s'], { cwd: join(root, 'borrowing'), env: quiet }).toString()).toContain('history kept elsewhere')
      const refusal = await refusalOf(() => call('git_log', { repo: 'borrowing' }))
      expect(refusal).toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining('borrows objects from outside the workspace') })
      expect(String(refusal)).not.toMatch(/history kept elsewhere|git-pack-named-store/)
    }
  })

  it.each([['<root>/link/..'], ['../../../link/..'], ['<root>/file-link/../objects']])('refuses a store reached by the line %s, a `..` after a link to a folder or a file, as git itself reads it', async line => {
    const quiet = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, env: quiet, stdio: 'pipe' })
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'git-pack-link-store-')))
    const elsewhere = join(parent, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'a.txt'), 'history kept elsewhere\n')
    git(elsewhere, 'init', '-q')
    git(elsewhere, 'add', 'a.txt')
    git(elsewhere, 'commit', '-qm', 'history kept elsewhere')
    const root = join(parent, 'root')
    mkdirSync(root)
    git(root, 'clone', '-q', '--shared', elsewhere, 'borrowing')
    symlinkSync(join(elsewhere, '.git', 'objects', 'info'), join(root, 'link'))
    symlinkSync(join(elsewhere, '.git', 'HEAD'), join(root, 'file-link'))
    const borrowing = join(root, 'borrowing')
    const file = join(borrowing, '.git', 'objects', 'info', 'alternates')
    writeFileSync(file, `${line.replace('<root>', root)}\n`)
    expect(execFileSync('git', ['log', '--format=%s'], { cwd: borrowing, env: quiet }).toString()).toContain('history kept elsewhere')
    const refusal = await refusalOf(() => gitPack(root, hostRunProcess, null, hostGit!).call('git_log', { repo: 'borrowing' }))
    expect(refusal).toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining('borrows objects from outside the workspace') })
    expect(String(refusal)).not.toMatch(/history kept elsewhere|git-pack-link-store/)
    // Folded as text this line is the store outside; git climbs out of a folder that does not exist and reads no store.
    writeFileSync(file, `${root}/nonexistent/../../elsewhere/.git/objects\n`)
    expect(() => execFileSync('git', ['log', '--format=%s'], { cwd: borrowing, env: quiet, stdio: 'pipe' })).toThrow(/unable to normalize alternate object path/)
  })
})

// `/proc/self/cwd` names the working directory of the process reading it: Buckle's for the check, and the work tree for
// git, which changes into it before it reads alternates. With the node started inside the root, a line through it, or
// through a link to it, landed inside for Buckle while git borrowed from outside (git pack recheck 3, held[0]).
describe.skipIf(hostGit === null || process.platform !== 'linux')('an alternates line through a per-process place, against the installed git', () => {
  const UNRESOLVED = 'cannot resolve as git does'
  const quiet = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, env: quiet, stdio: 'pipe' }).toString()
  const seeded = (directory: string, subject: string) => {
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'a.txt'), `${subject}\n`)
    git(directory, 'init', '-q')
    git(directory, 'add', 'a.txt')
    git(directory, 'commit', '-qm', subject)
  }
  /** `borrowing` shares an outside repository's objects and `sharing` an inside one's; `<root>/store` is a real folder, and the work tree's `store` a link outside. */
  function repositories() {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'git-pack-per-process-')))
    const root = join(parent, 'root')
    seeded(join(parent, 'elsewhere'), 'history kept elsewhere')
    seeded(join(root, 'origin'), 'history kept inside')
    git(root, 'clone', '-q', '--shared', join(parent, 'elsewhere'), 'borrowing')
    git(root, 'clone', '-q', '--shared', join(root, 'origin'), 'sharing')
    mkdirSync(join(root, 'store'))
    symlinkSync(join(parent, 'elsewhere', '.git', 'objects'), join(root, 'borrowing', 'store'))
    const alternates = (repo: string, line: string) => writeFileSync(join(root, repo, '.git', 'objects', 'info', 'alternates'), `${line.replace('<root>', root)}\n`)
    return { parent, root, alternates }
  }
  /** git_log on `repo` with the node working in `cwd`, as a node started there by `buckle serve` would. */
  async function logFrom(cwd: string, root: string, repo: string): Promise<unknown> {
    const before = process.cwd()
    process.chdir(cwd)
    try { return await gitPack(root, hostRunProcess, null, hostGit!).call('git_log', { repo }) } finally { process.chdir(before) }
  }
  async function refusedFrom(cwd: string, root: string, parent: string, reason?: string) {
    const refusal = await refusalOf(() => logFrom(cwd, root, 'borrowing'))
    expect(refusal).toMatchObject({ code: 'PERMISSION_DENIED', ...(reason ? { message: expect.stringContaining(reason) } : {}) })
    expect(String(refusal)).not.toMatch(/history kept elsewhere/)
    expect(String(refusal)).not.toContain(parent)
  }

  it.each([
    { line: '/proc/self/cwd/store', link: null, form: 'written as it is' },
    { line: '/proc/thread-self/cwd/store', link: null, form: 'written as it is' },
    { line: '<root>/lnk', link: '/proc/self/cwd/store', form: 'a link to /proc/self/cwd/store' },
    { line: '../../../lnk', link: '/proc/self/cwd/store', form: 'a link to /proc/self/cwd/store' },
  ])('refuses the line $line, $form, which git reads from its own working directory, with the node working in the root', async ({ line, link }) => {
    const { parent, root, alternates } = repositories()
    if (link) symlinkSync(link, join(root, 'lnk'))
    alternates('borrowing', line)
    expect(git(join(root, 'borrowing'), 'log', '--format=%s')).toContain('history kept elsewhere')
    await refusedFrom(root, root, parent, UNRESOLVED)
  })

  it('refuses a line through a link whose target starts with /dev/, with the constant reason', async () => {
    const { parent, root, alternates } = repositories()
    symlinkSync('/dev/null', join(root, 'lnk'))
    alternates('borrowing', '<root>/lnk')
    await refusedFrom(root, root, parent, UNRESOLVED)
  })

  it('refuses a line through /dev/fd, which names the descriptors of the process reading it', async () => {
    const { parent, root, alternates } = repositories()
    const descriptor = openSync(root, 'r')
    try {
      alternates('borrowing', `/dev/fd/${descriptor}/store`)
      await refusedFrom(root, root, parent, UNRESOLVED)
    } finally { closeSync(descriptor) }
  })

  it('refuses the line /proc/self/cwd/store with the node working outside the root, as before', async () => {
    const { parent, root, alternates } = repositories()
    alternates('borrowing', '/proc/self/cwd/store')
    await refusedFrom(parent, root, parent)
  })

  it('still reads a plain line inside, and one through a chain of ordinary links inside, written absolute or relative', async () => {
    const { root, alternates } = repositories()
    expect(await logFrom(root, root, 'sharing')).toMatchObject({ commits: [{ subject: 'history kept inside' }] })
    symlinkSync('second', join(root, 'first'))
    symlinkSync('origin/.git/objects', join(root, 'second'))
    for (const line of ['<root>/first', '../../../first']) {
      alternates('sharing', line)
      expect(await logFrom(root, root, 'sharing')).toMatchObject({ commits: [{ subject: 'history kept inside' }] })
    }
  })
})

// `blame.ignoreRevsFile` names a file git blame reads as object ids and dies quoting the first line that is none, so a
// repository's own config printed the first line of any file the node's user can read, in the error the agent gets, with
// no read of that file judged (git pack recheck 4, held[1]). No later config value empties the list, so the command line
// is the guard (`--no-ignore-revs-file`), and a config that names the key refuses git_blame.
describe('git_blame and a repository config that names a file for it to read', () => {
  const NAMES_A_FILE = 'names a file for git blame to read'
  /** The config entries a request carries in its environment, as the pack hands them to git. */
  const configOf = (request: ProcessRequest) => Array.from({ length: Number(request.environment.GIT_CONFIG_COUNT ?? 0) }, (_, index) => [request.environment[`GIT_CONFIG_KEY_${index}`], request.environment[`GIT_CONFIG_VALUE_${index}`]])
  /** A git that answers the query as a repository of its own, and the config listing with `keys`. */
  function listing(keys: string[]) {
    return vi.fn<ProcessRunner>(async request => {
      const answer = (stdout: string, exitCode = 0) => ({ exitCode, signal: null, stderr: '', truncated: false, timedOut: false, stdout })
      if (request.args[0] === 'rev-parse') return answer(`${request.cwd}\n${request.cwd}/.git\n${request.cwd}/.git\n`)
      if (request.args[0] === 'config') return answer(keys.map(key => `${key}\0`).join(''))
      return request.args[0] === 'blame' ? answer(`${'a'.repeat(40)} 1 1 1\nauthor t\n\tline\n`) : answer('')
    })
  }
  function repository() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'git-pack-blame-config-')))
    mkdirSync(join(root, 'repo', '.git'), { recursive: true })
    return root
  }
  const blameOf = (runProcess: ReturnType<typeof listing>) => runProcess.mock.calls.map(([request]) => request).filter(request => request.args[0] === 'blame')

  it('hands git --no-ignore-revs-file beside --no-textconv, and an empty blame.ignoreRevsFile to the blame alone', async () => {
    const root = repository()
    const runProcess = listing(['core.filemode'])
    await gitPack(root, runProcess).call('git_blame', { repo: 'repo', path: 'a.txt' })
    const requests = runProcess.mock.calls.map(([request]) => request)
    const [blame] = blameOf(runProcess)
    expect(blame!.args.slice(0, 4)).toEqual(['blame', '--line-porcelain', '--no-textconv', '--no-ignore-revs-file'])
    expect(configOf(blame!)).toContainEqual(['blame.ignoreRevsFile', ''])
    // The listing runs under the same scope without it: it would name the key in every repository, and refuse them all.
    for (const request of requests.filter(request => request.args[0] !== 'blame')) expect(configOf(request).map(([key]) => key)).not.toContain('blame.ignoreRevsFile')
  })

  it.each(['blame.ignorerevsfile', 'Blame.IgnoreRevsFile'])('refuses git_blame, with a constant reason and no blame run, where the config lists %s', async key => {
    const root = repository()
    const runProcess = listing(['core.filemode', key])
    const refusal = await refusalOf(() => gitPack(root, runProcess).call('git_blame', { repo: 'repo', path: 'a.txt' }))
    expect(refusal).toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining(NAMES_A_FILE) })
    expect(String(refusal)).not.toContain(root)
    expect(runProcess.mock.calls.map(([request]) => request.args[0])).toEqual(['rev-parse', 'config'])
  })

  it.each([['git_status', {}], ['git_diff', {}], ['git_log', {}], ['git_branch', {}]] as const)('still runs %s where the config lists it, as only blame reads the file', async (tool, args) => {
    const root = repository()
    const runProcess = listing(['blame.ignorerevsfile'])
    await gitPack(root, runProcess).call(tool, { ...args, repo: 'repo' })
    expect(runProcess.mock.calls.map(([request]) => request.args[0])).toEqual(['rev-parse', 'config', tool.replace('git_', '')])
  })
})

describe.skipIf(hostGit === null)('git_blame and a repository config that names a file for it to read, against the installed git', () => {
  const quiet = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, env: quiet, stdio: 'pipe' }).toString()
  /** A committed repository inside the root, and a readable file beside the root that is no revision list. */
  function repository() {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'git-pack-blame-live-')))
    const root = join(parent, 'root')
    const repo = join(root, 'repo')
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, 'a.txt'), 'hello\n')
    git(repo, 'init', '-q')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'first')
    writeFileSync(join(parent, 'outside-notes.txt'), 'neutral-secret-value-one\nsecond line\n')
    return { parent, root, repo, notes: join(parent, 'outside-notes.txt') }
  }
  const blame = (root: string) => gitPack(root, hostRunProcess, null, hostGit!).call('git_blame', { repo: 'repo', path: 'a.txt' })

  it('blames a plain repository', async () => {
    const { root } = repository()
    expect(await blame(root)).toMatchObject({ lines: [{ author: 't', text: 'hello' }] })
  })

  it('refuses a config naming a readable file outside, and shows no line of that file', async () => {
    const { parent, root, repo, notes } = repository()
    appendFileSync(join(repo, '.git', 'config'), `[blame]\n\tignoreRevsFile = ${notes}\n`)
    // The read this closes: git itself dies quoting the first line of the file.
    expect(() => git(repo, 'blame', '--line-porcelain', '--', 'a.txt')).toThrow(/neutral-secret-value-one/)
    const refusal = await refusalOf(() => blame(root))
    expect(refusal).toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining('names a file for git blame to read') })
    expect(String(refusal)).not.toMatch(/neutral-secret-value-one|second line|outside-notes/)
    expect(String(refusal)).not.toContain(parent)
  })
})

// A gitlink's work-tree `.git` pointer may lead outside the workspace, and git followed it wherever the repository's own
// config asked (`diff.submodule`, `status.submoduleSummary`), showing that repository's commits in a diff and its state in
// a status (git pack recheck 1, held[1]). The read pack never enters a submodule.
describe('a git tool never enters a submodule', () => {
  const SUBMODULE_CONFIG = { 'diff.ignoreSubmodules': 'all', 'diff.submodule': 'short', 'status.submoduleSummary': 'false', 'submodule.recurse': 'false' }
  /** The config scope a spawn carries, by key, as git reads GIT_CONFIG_COUNT and its pairs. */
  const configOf = (request: ProcessRequest) => {
    const environment = request.environment ?? {}
    return Object.fromEntries(Array.from({ length: Number(environment.GIT_CONFIG_COUNT ?? 0) }, (_, index) => [environment[`GIT_CONFIG_KEY_${index}`], environment[`GIT_CONFIG_VALUE_${index}`]]))
  }

  it('hands git_status and git_diff --ignore-submodules=all, and every spawn the submodule keys', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'git-pack-submodule-')))
    mkdirSync(join(root, '.git'))
    for (const tool of ['git_status', 'git_diff']) {
      const runProcess = answering()
      await gitPack(root, runProcess).call(tool, {})
      const requests = runProcess.mock.calls.map(([request]) => request)
      expect(requests.at(-1)!.args, tool).toContain('--ignore-submodules=all')
      for (const request of requests) expect(configOf(request), `${tool} ${request.args[0]}`).toMatchObject(SUBMODULE_CONFIG)
    }
  })
})

describe.skipIf(hostGit === null)('a git tool never enters a submodule, against the installed git', () => {
  const quiet = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, env: quiet, stdio: 'pipe' }).toString().trim()
  /**
   * A repository outside the workspace root with two commits, and one inside whose gitlink `sub` names the first of them
   * and whose work-tree `sub/.git` points at the outside one, with `view` as its own `diff.submodule`.
   */
  function submodule(view: string) {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'git-pack-submodule-live-')))
    const elsewhere = join(parent, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'a.txt'), 'first\n')
    git(elsewhere, 'init', '-q')
    git(elsewhere, 'add', 'a.txt')
    git(elsewhere, 'commit', '-qm', 'first outside subject')
    const first = git(elsewhere, 'rev-parse', 'HEAD')
    writeFileSync(join(elsewhere, 'a.txt'), 'second\n')
    git(elsewhere, 'commit', '-qam', 'subject recorded only outside the workspace')
    const second = git(elsewhere, 'rev-parse', 'HEAD')
    const root = join(parent, 'ws')
    const repo = join(root, 'repo')
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, 'b.txt'), 'inside\n')
    git(repo, 'init', '-q')
    git(repo, 'add', 'b.txt')
    git(repo, 'update-index', '--add', '--cacheinfo', `160000,${first},sub`)
    git(repo, 'commit', '-qm', 'inside subject')
    mkdirSync(join(repo, 'sub'))
    writeFileSync(join(repo, 'sub', '.git'), `gitdir: ${join(elsewhere, '.git')}\n`)
    git(repo, 'config', 'diff.submodule', view)
    git(repo, 'config', 'status.submoduleSummary', 'true')
    return { root, repo, elsewhere, first, second }
  }

  it.each([['log'], ['diff'], ['short']])('shows nothing of the submodule in git_diff, staged or not, or git_status, under diff.submodule=%s in the repository config', async view => {
    const { root, repo, second } = submodule(view)
    const { call } = gitPack(root, hostRunProcess, null, hostGit!)
    expect(await call('git_diff', { repo: 'repo' })).toEqual({ diff: '' })
    expect(await call('git_status', { repo: 'repo' })).toMatchObject({ entries: [], clean: true })
    git(repo, 'update-index', '--cacheinfo', `160000,${second},sub`)
    expect(await call('git_diff', { repo: 'repo', staged: true })).toEqual({ diff: '' })
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('still runs git_diff and git_status when the outside repository\'s git folder is unreadable', async () => {
    const { root, elsewhere } = submodule('log')
    chmodSync(join(elsewhere, '.git'), 0)
    try {
      const { call } = gitPack(root, hostRunProcess, null, hostGit!)
      expect(await call('git_diff', { repo: 'repo' })).toEqual({ diff: '' })
      expect(await call('git_status', { repo: 'repo' })).toMatchObject({ entries: [], clean: true })
    } finally { chmodSync(join(elsewhere, '.git'), 0o755) }
  })

  // git_log prints no patch and git_blame reads no gitlink, so neither needed a change; pinned, they pass before and after.
  it('lists only the repository\'s own commits from git_log, naming the gitlink or not, and git_blame refuses the gitlink', async () => {
    const { root } = submodule('log')
    const { call } = gitPack(root, hostRunProcess, null, hostGit!)
    expect(await call('git_log', { repo: 'repo' })).toMatchObject({ commits: [{ subject: 'inside subject' }] })
    expect(await call('git_log', { repo: 'repo', path: 'sub' })).toMatchObject({ commits: [{ subject: 'inside subject' }] })
    const refusal = await refusalOf(() => call('git_blame', { repo: 'repo', path: 'sub' }))
    expect(refusal).toMatchObject({ code: 'GIT_FAILED' })
    expect(String(refusal)).not.toContain('outside')
  })
})
