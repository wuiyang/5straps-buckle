import { mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { JsonValue } from '@5straps/protocol'
import { createPathView } from '../common/domain/path-view.js'
import { createGitPack } from '../common/services/packs/git/index.js'
import type { ToolContext } from '../common/domain/tool.js'
import type { ProcessRunner } from '../common/types/ports/process-runner.js'

function gitPack(root: string, runProcess: ProcessRunner = vi.fn()) {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'git-pack-state-'))
  const pack = createGitPack({ paths: createPathView({ root, mount: null, scratchRoots: [] }), runProcess, stateDirectory, git: { path: 'git', argv0: 'git' } })
  const call = (name: string, args: Record<string, JsonValue>, judged: Pick<ToolContext, 'authorizeReadTarget'> = {}) => {
    const tool = pack.tools.find(candidate => candidate.capability.name === name)
    if (!tool) throw new Error(`No such tool: ${name}`)
    return tool.prepare(args).execute({ requestId: 'req-1', sessionId: 'chat-1', timeoutMs: 1_000, signal: AbortSignal.timeout(1_000), ...judged })
  }
  return { call, runProcess }
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
    for (const name of ['repoA', 'repoB']) mkdirSync(join(root, name))
    symlinkSync('repoA', join(root, 'repo'))
    return root
  }

  it('hands git the judged real path, not the link it was named by', async () => {
    const root = repositories()
    const runProcess = vi.fn<ProcessRunner>(async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false }))
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
    const pack = createGitPack({ paths: createPathView({ root, mount: null, scratchRoots: [] }), runProcess: vi.fn(), stateDirectory: mkdtempSync(join(tmpdir(), 'git-pack-state-')), git: { path: 'git', argv0: 'git' } })
    const blame = pack.tools.find(candidate => candidate.capability.name === 'git_blame')!
    expect(blame.prepare({ repo: 'repo', path: 'src/a.txt' }).effects).toEqual([{ kind: 'read_path', path: 'repo' }, { kind: 'read_path', path: 'repo/src/a.txt' }])
  })
})

// git_blame judged where the file really is and then handed git the agent's own string, which git resolves again: a link
// swapped after the check, or a name git reads otherwise, reached another file than the one judged.
describe('git_blame hands git the file its permission check judged', () => {
  function repository() {
    const root = mkdtempSync(join(tmpdir(), 'git-pack-blame-'))
    mkdirSync(join(root, 'repoA', 'src'), { recursive: true })
    for (const name of ['a.txt', 'b.txt']) writeFileSync(join(root, 'repoA', 'src', name), `${name}\n`)
    symlinkSync('repoA', join(root, 'repo'))
    symlinkSync('src', join(root, 'repoA', 'alias'))
    symlinkSync('a.txt', join(root, 'repoA', 'src', 'current.txt'))
    return root
  }
  const ran = () => vi.fn<ProcessRunner>(async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false }))
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
