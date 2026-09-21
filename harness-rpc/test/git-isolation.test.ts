import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { JsonValue } from '@5straps/protocol'
import { runProcess } from '../src/adapters/process-runner.js'
import { buildChildEnvironment } from '../src/domain/environment.js'
import { hasExecutable } from '../src/domain/executable.js'
import { createPathView } from '../src/domain/path-view.js'
import { createGitPack } from '../src/packs/git/index.js'
import { filterProgramOverrides } from '../src/packs/git-isolation.js'

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
  const root = mkdtempSync(join(tmpdir(), 'git-isolation-workspace-'))
  const outside = mkdtempSync(join(tmpdir(), 'git-isolation-outside-'))
  const stateDirectory = mkdtempSync(join(tmpdir(), 'git-isolation-state-'))
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
    runProcess, stateDirectory: input.stateDirectory, hasGit: true,
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
