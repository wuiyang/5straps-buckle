import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    for (const [tool, args] of tools) await expect(call(tool, { ...args, repo: '.' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
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
    expect(runProcess.mock.calls.at(-1)![0].args.slice(1)).toEqual(['--unified=3', '--no-color', '--no-ext-diff', '--no-textconv'])
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

  it('refuses a line whose quoting is broken, even one naming a store inside', async () => {
    const { root, repo, outside } = workspace()
    for (const line of [`"${join(root, 'shared')}`, `"${join(root, 'shared')}\\q"`, `"${join(root, 'shared')}"trailing`]) {
      alternates(join(repo, '.git', 'objects'), line)
      await refused(root, answeringAt(plain(repo)), outside)
    }
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
})
