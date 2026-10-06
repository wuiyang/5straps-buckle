import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonValue } from '@5straps/protocol'
import { runProcess } from '../common/adapters/process-runner.js'
import { buildChildEnvironment } from '../common/domain/environment.js'
import { hasExecutable } from '../common/domain/executable.js'
import { createPathView } from '../common/domain/path-view.js'
import { createGitPack } from '../common/services/packs/git/index.js'
import { filterProgramOverrides, ISOLATION_ENVIRONMENT } from '../common/services/packs/git-isolation.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function temporaryDirectory(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

const READ_TOOL_CALLS: Array<[string, Record<string, JsonValue>]> = [
  ['git_status', {}],
  ['git_diff', {}],
  ['git_log', {}],
  ['git_blame', { path: 'a.txt' }],
  ['git_branch', {}],
]

/**
 * A workspace that wants a read tool to run its code: every repository-config knob and hook that
 * names a program points at one script, which records that it ran to a file outside the
 * workspace. One driver is defined in `.git/config` and a second through an `include`, so the
 * refusal has to come from what git resolves rather than from a parse of the one file.
 */
async function hostileRepository(): Promise<{ root: string; marker: string; stateDirectory: string }> {
  const root = temporaryDirectory('git-isolation-workspace-')
  const outside = temporaryDirectory('git-isolation-outside-')
  const stateDirectory = temporaryDirectory('git-isolation-state-')
  const marker = join(outside, 'programs-that-ran')
  const probe = join(root, 'probe.sh')
  writeFileSync(probe, `#!/bin/sh\necho "$1" >> ${marker}\ncat >/dev/null 2>&1\nexit 0\n`)
  chmodSync(probe, 0o755)

  const git = async (...args: string[]): Promise<void> => {
    const result = await runProcess({
      command: 'git', args, cwd: root, timeoutMs: 20_000,
      environment: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: outside, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
    })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }

  await git('init', '--initial-branch=main')
  await git('config', 'user.email', 'probe@example.com')
  await git('config', 'user.name', 'Probe')
  writeFileSync(join(root, 'a.txt'), 'aaaa\nbbbb\n')
  writeFileSync(join(root, 'b.txt'), 'cccc\ndddd\n')
  await git('add', 'a.txt', 'b.txt')
  await git('commit', '--message', 'first')

  await git('config', 'core.fsmonitor', `${probe} fsmonitor`)
  await git('config', 'diff.driven.command', `${probe} external-diff-driver`)
  await git('config', 'diff.driven.textconv', `${probe} textconv`)
  await git('config', 'filter.driven.clean', `${probe} clean-filter`)
  await git('config', 'core.pager', `${probe} pager`)
  await git('config', 'gpg.program', `${probe} gpg`)
  await git('config', 'core.askpass', `${probe} askpass`)
  await git('config', 'log.showSignature', 'true')
  writeFileSync(join(root, '.git', 'included.config'), `[filter "included"]\n\tclean = ${probe} included-clean-filter\n`)
  await git('config', 'include.path', 'included.config')
  writeFileSync(join(root, '.gitattributes'), 'a.txt diff=driven filter=driven\nb.txt filter=included\n')

  mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
  for (const hook of ['pre-commit', 'post-checkout', 'post-index-change']) {
    const path = join(root, '.git', 'hooks', hook)
    writeFileSync(path, `#!/bin/sh\necho "hook-${hook}" >> ${marker}\nexit 0\n`)
    chmodSync(path, 0o755)
  }

  // Same-size edits, so git has to hash the working tree files rather than call them modified on
  // their length alone, which is what sends a clean filter their content.
  writeFileSync(join(root, 'a.txt'), 'aaaa\nbbbX\n')
  writeFileSync(join(root, 'b.txt'), 'cccc\ndddX\n')
  return { root, marker, stateDirectory }
}

function readToolCall(input: { root: string; stateDirectory: string }) {
  const pack = createGitPack({
    paths: createPathView({ root: input.root, mount: null, scratchRoots: [] }),
    runProcess, stateDirectory: input.stateDirectory, git: { path: 'git' },
  })
  return (name: string, args: Record<string, JsonValue>): Promise<JsonValue> => {
    const tool = pack.tools.find(candidate => candidate.capability.name === name)
    if (!tool) throw new Error(`No such tool: ${name}`)
    return tool.prepare(args).execute({ requestId: 'req-1', sessionId: 'chat-1', timeoutMs: 20_000, signal: AbortSignal.timeout(20_000) })
  }
}

describe.runIf(hasExecutable('git'))('a read-risk git tool in a repository whose config names programs', () => {
  it('leaves the fixture proven: host git run the way the pack used to run it does execute them', async () => {
    const { root, marker } = await hostileRepository()

    const result = await runProcess({
      command: 'git', args: ['status', '--porcelain=v2', '--branch'], cwd: root, timeoutMs: 20_000,
      environment: buildChildEnvironment({ parent: process.env, extra: { GIT_TERMINAL_PROMPT: '0' } }),
    })

    expect(result.exitCode).toBe(0)
    expect(readFileSync(marker, 'utf8')).toContain('fsmonitor')
  }, 60_000)

  it('runs none of them, and writes nothing outside the workspace, for any of the five tools', async () => {
    const repository = await hostileRepository()
    const call = readToolCall(repository)

    for (const [tool, args] of READ_TOOL_CALLS) {
      await expect(call(tool, args), `${tool} should not fail in a repository that defines filter drivers`).resolves.toBeDefined()
      expect(existsSync(repository.marker), `${tool} ran a program the repository config named: ${existsSync(repository.marker) ? readFileSync(repository.marker, 'utf8') : ''}`).toBe(false)
    }
  }, 120_000)

  it('documents why config hardening still requires an owner opt-in: tracked credential diffs are visible', async () => {
    const repository = await hostileRepository()
    writeFileSync(join(repository.root, 'credentials.json'), '{"synthetic":"before"}\n')
    const added = await runProcess({ command: 'git', args: ['add', 'credentials.json'], cwd: repository.root,
      timeoutMs: 20_000, environment: buildChildEnvironment({ parent: process.env, extra: ISOLATION_ENVIRONMENT }) })
    expect(added.exitCode).toBe(0)
    writeFileSync(join(repository.root, 'credentials.json'), '{"synthetic":"after-private-marker"}\n')
    const result = await readToolCall(repository)('git_diff', {})
    expect(JSON.stringify(result)).toContain('after-private-marker')
  }, 60_000)

  it('still answers with the repository it was asked about', async () => {
    const repository = await hostileRepository()
    const call = readToolCall(repository)

    const status = await call('git_status', {}) as { branch: string; clean: boolean; entries: Array<{ path: string }> }
    expect(status.branch).toBe('main')
    expect(status.clean).toBe(false)
    expect(status.entries.map(entry => entry.path)).toContain('a.txt')

    const diff = await call('git_diff', {}) as { diff: string }
    expect(diff.diff).toContain('bbbX')

    const log = await call('git_log', {}) as { commits: Array<{ subject: string }> }
    expect(log.commits.map(commit => commit.subject)).toEqual(['first'])

    const blame = await call('git_blame', { path: 'a.txt' }) as { lines: Array<{ author: string }> }
    expect(blame.lines[0]?.author).toBe('Probe')
  }, 120_000)
})

describe('the filter drivers a repository defines', () => {
  it('are emptied one configured key at a time, and nothing else is', () => {
    expect(filterProgramOverrides([
      'filter.lfs.clean', 'filter.lfs.smudge', 'filter.lfs.process', 'filter.lfs.required',
      'core.fsmonitor', 'diff.driven.textconv', 'filterkeeper.clean',
    ])).toEqual([
      { key: 'filter.lfs.clean', value: '' },
      { key: 'filter.lfs.smudge', value: '' },
      { key: 'filter.lfs.process', value: '' },
    ])
  })
})

/**
 * `pager.<cmd>` names a program per command, so no one config key resets it and the override
 * scope's `core.pager` loses to it. Git reads `GIT_PAGER` ahead of both, which is what the
 * isolation environment carries. Git pages nothing when its output is a pipe, so a terminal has
 * to be borrowed to ask the question at all: `script` gives git the tty it wants.
 *
 * The repository here names one program and nothing else, so the marker can only be the pager.
 */
describe.runIf(hasExecutable('git') && hasExecutable('script'))('a repository that names a pager for one command', () => {
  async function pagingRepository(): Promise<{ root: string; marker: string }> {
    const root = temporaryDirectory('git-pager-workspace-')
    const marker = join(temporaryDirectory('git-pager-outside-'), 'pager-that-ran')
    const probe = join(root, 'pager.sh')
    writeFileSync(probe, `#!/bin/sh\necho ran >> ${marker}\ncat\n`)
    chmodSync(probe, 0o755)

    const git = async (...args: string[]): Promise<void> => {
      const result = await runProcess({
        command: 'git', args, cwd: root, timeoutMs: 20_000,
        environment: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
      })
      if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
    }
    await git('init', '--initial-branch=main')
    await git('config', 'user.email', 'probe@example.com')
    await git('config', 'user.name', 'Probe')
    writeFileSync(join(root, 'a.txt'), 'aaaa\n')
    await git('add', 'a.txt')
    await git('commit', '--message', 'first')
    writeFileSync(join(root, 'a.txt'), 'bbbb\n')
    await git('config', 'pager.status', probe)
    return { root, marker }
  }

  /** Git pages only what it writes to a terminal, so `script` lends it one. */
  async function statusOnATerminal(input: { root: string; environment: NodeJS.ProcessEnv }): Promise<void> {
    await runProcess({
      command: 'script',
      args: ['-qec', 'git status --porcelain=v2', '/dev/null'],
      cwd: input.root,
      timeoutMs: 20_000,
      environment: input.environment,
    })
  }

  it('leaves the fixture proven: git on a terminal runs it, and an emptied core.pager does not stop it', async () => {
    const { root, marker } = await pagingRepository()

    await statusOnATerminal({ root, environment: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: 'cat',
    } })

    expect(readFileSync(marker, 'utf8')).toContain('ran')
  }, 60_000)

  it('does not run it under the isolation environment every git call carries', async () => {
    const { root, marker } = await pagingRepository()

    await statusOnATerminal({ root, environment: buildChildEnvironment({ parent: process.env, extra: { ...ISOLATION_ENVIRONMENT, HOME: root } }) })

    expect(existsSync(marker), existsSync(marker) ? readFileSync(marker, 'utf8') : '').toBe(false)
  }, 60_000)
})
