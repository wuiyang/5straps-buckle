import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { emptyWorkspacePolicy, type JsonValue } from '@5straps/protocol'
import { runProcess as hostRunProcess } from '../common/adapters/process-runner.js'
import { findExecutable } from '../common/domain/executable.js'
import { createFilesystemPolicyRule } from '../common/domain/filesystem-policy.js'
import { createPermissionEngine } from '../common/domain/permission/engine.js'
import { createReadScopeRule } from '../common/domain/permission/rules/read-scope-rule.js'
import { createSensitivePathRule } from '../common/domain/permission/rules/sensitive-path-rule.js'
import { createPathView } from '../common/domain/path-view.js'
import { ToolInputError, type ToolContext } from '../common/domain/tool.js'
import { resolveHostRead } from '../common/services/invocation/resolve-effects.js'
import { createGitPack } from '../common/services/packs/git/index.js'
import type { ProcessRequest, ProcessResult, ProcessRunner } from '../common/types/ports/process-runner.js'

// R1 (D77, owner 2026-10-25): "diff should censor the content, but still show that the file did have change if
// possible". git_diff with no path, or a folder, showed every tracked file's changes beneath, a `.env` included, with no
// credential-file ask. Each file it lists is now judged as a read the tool reached mid-call (authorizeRead): one the
// rules would not let the agent read keeps its header and a stat, and its hunks become `[content hidden: <rule>]`.

type Judged = Pick<ToolContext, 'authorizeRead' | 'authorizeReadTarget'>

function gitPack(root: string, runProcess: ProcessRunner, git = 'git') {
  const pack = createGitPack({ paths: createPathView({ root, mount: null, scratchRoots: [] }), runProcess, stateDirectory: mkdtempSync(join(tmpdir(), 'git-pack-diff-state-')), git: { path: git, argv0: 'git', args: [] } })
  const tool = pack.tools.find(candidate => candidate.capability.name === 'git_diff')!
  return (args: Record<string, JsonValue>, judged: Judged = {}) => tool.prepare(args).execute({ requestId: 'req-1', sessionId: 'chat-1', timeoutMs: 20_000, signal: AbortSignal.timeout(20_000), ...judged }) as Promise<{ diff: string }>
}

/**
 * A read the tool reached mid-call, judged as the invoker judges one (invoker.ts, authorizeRead): resolved where it lands
 * now, then the node's own read rules in their order, with `deny` as the owner's read deny rules and `granted` as the
 * credential files this call's approval covered.
 */
function readRules(root: string, options: { deny?: string[]; granted?: string[] } = {}): Judged {
  const paths = createPathView({ root, mount: null, scratchRoots: [] })
  const policy = { ...emptyWorkspacePolicy(), filesystem: { rules: (options.deny ?? []).map(path => ({ path, read: 'deny' as const })) } }
  const engine = createPermissionEngine([createSensitivePathRule(), createFilesystemPolicyRule({ root, policy }), createReadScopeRule({ paths })])
  const granted = options.granted ?? []
  return {
    authorizeRead: async path => {
      const effect = await resolveHostRead(path).catch((error: unknown) => { if (error instanceof ToolInputError) return null; throw error })
      if (effect === null) return false
      return engine.evaluate({ tool: 'git_diff', effects: [effect], grants: { subjectsFor: rule => rule === 'sensitive_path' ? granted : [] } }).kind === 'allow'
    },
  }
}

const hostGit = findExecutable('git')
const quiet = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, env: quiet, stdio: 'pipe' }).toString()

/** A repository with `committed` in its first commit, then each of `changed` written over the work tree. */
function repository(committed: Record<string, string | Buffer>, changed: Record<string, string | Buffer> = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'git-pack-diff-')))
  const write = (files: Record<string, string | Buffer>) => {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, name)), { recursive: true })
      writeFileSync(join(root, name), content)
    }
  }
  write(committed)
  git(root, 'init', '-q')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'seed')
  write(changed)
  return root
}

/** The fixture R1 names: a changed `.env`, a changed file under a read deny, a changed plain file, and one forging a header. */
function censored(): string {
  return repository({
    '.env': 'NAME=committed-env-marker\n',
    'secrets/token.txt': 'committed-token-marker\n',
    'plain.txt': 'plain\n',
    'forged.txt': 'forged\n',
  }, {
    '.env': 'NAME=planted-env-marker\n',
    'secrets/token.txt': 'planted-token-marker\n',
    'plain.txt': 'plain\nplain-change\n',
    'forged.txt': 'forged\ndiff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n+NAME=forged-env-line\n',
  })
}

const MARKERS = /committed-env-marker|planted-env-marker|committed-token-marker|planted-token-marker/
const ENV_STUB = 'diff --git a/.env b/.env\nstat: +1 -1\n[content hidden: credential file]\n'
const TOKEN_STUB = 'diff --git a/secrets/token.txt b/secrets/token.txt\nstat: +1 -1\n[content hidden: read rule]\n'

describe.skipIf(hostGit === null)('git_diff hides the content of a file the rules would not let the agent read, against the installed git', () => {
  it('keeps the header and a stat of a changed .env and a file under a read deny, and shows a plain file, in the work tree', async () => {
    const root = censored()
    const { diff } = await gitPack(root, hostRunProcess, hostGit!)({}, readRules(root, { deny: ['secrets'] }))
    expect(diff).toContain('+plain-change')
    expect(diff).toContain(ENV_STUB)
    expect(diff).toContain(TOKEN_STUB)
    expect(diff).not.toMatch(MARKERS)
  })

  it('does the same for the staged index', async () => {
    const root = censored()
    git(root, 'add', '-A')
    const { diff } = await gitPack(root, hostRunProcess, hostGit!)({ staged: true }, readRules(root, { deny: ['secrets'] }))
    expect(diff).toContain('+plain-change')
    expect(diff).toContain(ENV_STUB)
    expect(diff).toContain(TOKEN_STUB)
    expect(diff).not.toMatch(MARKERS)
  })

  it('shows a forged diff --git header inside a plain file as that file\'s content, never as a file of its own', async () => {
    const root = censored()
    const { diff } = await gitPack(root, hostRunProcess, hostGit!)({}, readRules(root, { deny: ['secrets'] }))
    expect(diff).toContain('+diff --git a/.env b/.env\n+--- a/.env\n++++ b/.env\n+@@ -1 +1 @@\n++NAME=forged-env-line\n')
    const lines = diff.split('\n')
    expect(lines.filter(line => line === 'diff --git a/.env b/.env')).toHaveLength(1)
    expect(lines.filter(line => line.startsWith('[content hidden: '))).toHaveLength(2)
  })

  it('hides a rename into a credential name, out of one, and keeps a plain rename\'s diff, staged', async () => {
    const notes = 'NOTE=committed\nnote line two\nnote line three\nnote line four\n'
    const root = repository({ 'notes.txt': notes, '.env.production': 'KEY=prod-marker\nKEY2=prod-second\n', 'a.txt': 'a one\na two\na three\n' })
    git(root, 'mv', 'notes.txt', '.env.local')
    writeFileSync(join(root, '.env.local'), `${notes}SECRET=after-rename-marker\n`)
    git(root, 'mv', '.env.production', 'public.txt')
    writeFileSync(join(root, 'public.txt'), 'KEY=prod-marker\nKEY2=prod-second\nPUBLIC=added\n')
    git(root, 'mv', 'a.txt', 'b.txt')
    writeFileSync(join(root, 'b.txt'), 'a one\na two\na three\nb four\n')
    git(root, 'add', '-A')
    const { diff } = await gitPack(root, hostRunProcess, hostGit!)({ staged: true }, readRules(root))
    expect(diff).toContain('diff --git a/notes.txt b/.env.local\nrename from notes.txt\nrename to .env.local\nstat: +1 -0\n[content hidden: credential file]\n')
    expect(diff).toContain('diff --git a/.env.production b/public.txt\nrename from .env.production\nrename to public.txt\nstat: +1 -0\n[content hidden: credential file]\n')
    expect(diff).toMatch(/rename from a\.txt\nrename to b\.txt\n[\s\S]*\+b four/)
    expect(diff).not.toMatch(/after-rename-marker|prod-marker|prod-second|NOTE=committed/)
  })

  it('hides a binary credential file with a binary stat, and still shows that a plain binary file differs', async () => {
    const root = repository({ 'cert.pem': Buffer.from([0, 1, 2, 3, 0x6b, 0x65, 0x79]), 'image.bin': Buffer.from([0, 9, 9, 9]) }, { 'cert.pem': Buffer.from([0, 1, 2, 4, 0x6b, 0x65, 0x79]), 'image.bin': Buffer.from([0, 8, 8, 8]) })
    const { diff } = await gitPack(root, hostRunProcess, hostGit!)({}, readRules(root))
    expect(diff).toContain('diff --git a/cert.pem b/cert.pem\nstat: binary\n[content hidden: credential file]\n')
    expect(diff).toContain('Binary files a/image.bin and b/image.bin differ')
  })

  it.skipIf(process.platform === 'win32')('reads paths with spaces and newlines whole, quoting a hidden one\'s header as git quotes it', async () => {
    const root = repository({ 'dir with space/.env': 'S=space-committed-marker\n', 'dir with space/notes.txt': 'n\n', 'new\nline.txt': 'l\n', 'odd\nname/.env': 'S=newline-committed-marker\n' }, {
      'dir with space/.env': 'S=space-planted-marker\n', 'dir with space/notes.txt': 'n\nspace-change\n', 'new\nline.txt': 'l\nnewline-change\n', 'odd\nname/.env': 'S=newline-planted-marker\n',
    })
    const { diff } = await gitPack(root, hostRunProcess, hostGit!)({}, readRules(root))
    expect(diff).toContain('diff --git a/dir with space/.env b/dir with space/.env\nstat: +1 -1\n[content hidden: credential file]\n')
    expect(diff).toContain('diff --git "a/odd\\nname/.env" "b/odd\\nname/.env"\nstat: +1 -1\n[content hidden: credential file]\n')
    expect(diff).toContain('+space-change')
    expect(diff).toContain('+newline-change')
    expect(diff).not.toMatch(/space-committed-marker|space-planted-marker|newline-committed-marker|newline-planted-marker/)
    expect(diff.split('\n')).not.toContain('name/.env b/odd')
  })

  it.skipIf(process.platform === 'win32')('hides a tracked link and a file beneath a folder now a link, as the rules would judge another place than git shows', async () => {
    const root = repository({ '.env': 'E=link-env-marker\n', 'docs/readme.txt': 'readme-committed-marker\n', 'secrets/kept.txt': 'kept\n' })
    symlinkSync('.env', join(root, 'env-link'))
    git(root, 'add', 'env-link')
    git(root, 'commit', '-qm', 'link')
    rmSync(join(root, 'env-link'))
    symlinkSync('secrets/kept.txt', join(root, 'env-link'))
    rmSync(join(root, 'docs'), { recursive: true })
    symlinkSync('secrets', join(root, 'docs'))
    const { diff } = await gitPack(root, hostRunProcess, hostGit!)({}, readRules(root))
    expect(diff).toContain('diff --git a/env-link b/env-link\nstat: +1 -1\n[content hidden: link on its path]\n')
    expect(diff).toContain('diff --git a/docs/readme.txt b/docs/readme.txt\ndeleted file mode 100644\nstat: +0 -1\n[content hidden: link on its path]\n')
    expect(diff).not.toMatch(/readme-committed-marker|link-env-marker/)
  })

  it('judges each file beneath a folder path argument, and shows nothing outside it', async () => {
    const root = repository({ 'config/.env': 'C=folder-committed-marker\n', 'config/app.txt': 'app\n', 'top.txt': 'top\n' }, { 'config/.env': 'C=folder-planted-marker\n', 'config/app.txt': 'app\napp-change\n', 'top.txt': 'top\ntop-change\n' })
    const { diff } = await gitPack(root, hostRunProcess, hostGit!)({ paths: ['config'] }, readRules(root))
    expect(diff).toContain('+app-change')
    expect(diff).toContain('diff --git a/config/.env b/config/.env\nstat: +1 -1\n[content hidden: credential file]\n')
    expect(diff).not.toMatch(/folder-committed-marker|folder-planted-marker|top/)
  })

  it('hides a shown path that a hidden file lies beneath, which git would read as that file\'s folder', async () => {
    const root = repository({ a: 'a-committed\n' })
    git(root, 'rm', '-q', 'a')
    mkdirSync(join(root, 'a'))
    writeFileSync(join(root, 'a', '.env'), 'SECRET=folder-file-marker\n')
    git(root, 'add', 'a/.env')
    const { diff } = await gitPack(root, hostRunProcess, hostGit!)({ staged: true }, readRules(root))
    expect(diff).toContain('diff --git a/a b/a\ndeleted file mode 100644\nstat: +0 -1\n[content hidden: hidden file beneath it]\n')
    expect(diff).toContain('diff --git a/a/.env b/a/.env\nnew file mode 100644\nstat: +1 -0\n[content hidden: credential file]\n')
    expect(diff).not.toContain('folder-file-marker')
  })

  it('hides every file where the call carries no read check, as a tool run outside the invoker does', async () => {
    const root = censored()
    const { diff } = await gitPack(root, hostRunProcess, hostGit!)({})
    expect(diff).toContain('diff --git a/plain.txt b/plain.txt\nstat: +1 -0\n[content hidden: no read check]\n')
    expect(diff).not.toMatch(/plain-change|forged-env-line/)
    expect(diff).not.toMatch(MARKERS)
  })

  it('shows a .env the call named and its approval covered', async () => {
    const root = censored()
    const { diff } = await gitPack(root, hostRunProcess, hostGit!)({ paths: ['.env'] }, readRules(root, { granted: [join(root, '.env')] }))
    expect(diff).toContain('+NAME=planted-env-marker')
    expect(diff).not.toContain('[content hidden')
  })

  it('shows nothing of an unborn repository\'s staged .env, and its plain file', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'git-pack-diff-unborn-')))
    writeFileSync(join(root, '.env'), 'U=unborn-marker\n')
    writeFileSync(join(root, 'first.txt'), 'first-line\n')
    git(root, 'init', '-q')
    git(root, 'add', '-A')
    const { diff } = await gitPack(root, hostRunProcess, hostGit!)({ staged: true }, readRules(root))
    expect(diff).toContain('diff --git a/.env b/.env\nnew file mode 100644\nstat: +1 -0\n[content hidden: credential file]\n')
    expect(diff).toContain('+first-line')
    expect(diff).not.toContain('unborn-marker')
  })
})

/** A git that answers the repository query as a repository of its own, and each later command as `answers` says. */
function scripted(answers: (request: ProcessRequest) => Partial<ProcessResult> | null) {
  return vi.fn<ProcessRunner>(async request => {
    const done = (result: Partial<ProcessResult>): ProcessResult => ({ exitCode: 0, signal: null, stderr: '', truncated: false, timedOut: false, stdout: '', ...result })
    if (request.args[0] === 'rev-parse' && request.args.includes('--show-toplevel')) return done({ stdout: `${request.cwd}\n${request.cwd}/.git\n${request.cwd}/.git\n` })
    return done(answers(request) ?? {})
  })
}
const isListing = (request: ProcessRequest) => request.args[0] === 'diff' && request.args.includes('--raw')
const isPatch = (request: ProcessRequest) => request.args[0] === 'diff' && !request.args.includes('--raw')
const listingOf = (...records: Array<[status: string, paths: string[], counts: string]>) =>
  records.map(([status, paths]) => `:100644 100644 ${'1'.repeat(7)} ${'0'.repeat(7)} ${status}\0${paths.join('\0')}\0`).join('')
  + records.map(([, paths, counts]) => paths.length === 2 ? `${counts}\t\0${paths.join('\0')}\0` : `${counts}\t${paths[0]}\0`).join('')
const allowed: Judged = { authorizeRead: async () => true }
const allowedButEnv: Judged = { authorizeRead: async path => !path.endsWith('/.env') }

function workspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'git-pack-diff-scripted-')))
  mkdirSync(join(root, '.git'))
  return root
}

describe('git_diff runs git on the files it may show, from one listing', () => {
  it('runs no patch at all where every listed file is hidden, so the patch is never handed a bare --', async () => {
    const root = workspace()
    const runProcess = scripted(request => isListing(request) ? { stdout: listingOf(['M', ['.env'], '1\t1']) } : null)
    const { diff } = await gitPack(root, runProcess)({}, allowedButEnv)
    expect(diff).toBe('diff --git a/.env b/.env\nstat: +1 -1\n[content hidden: credential file]\n')
    const requests = runProcess.mock.calls.map(([request]) => request)
    expect(requests.filter(isPatch)).toEqual([])
    expect(requests.filter(isListing).map(request => request.args.at(-1))).toEqual(['--'])
  })

  it('hands the patch only the shown files, both sides of a rename, after a --, and the hidden ones nowhere', async () => {
    const root = workspace()
    const runProcess = scripted(request => isListing(request)
      ? { stdout: listingOf(['M', ['plain.txt'], '1\t0'], ['R100', ['old name.txt', 'new name.txt'], '0\t0'], ['M', ['.env'], '1\t1'], ['M', [':colon\tname.txt'], '2\t0']) }
      : null)
    await gitPack(root, runProcess)({}, allowedButEnv)
    const [patch] = runProcess.mock.calls.map(([request]) => request).filter(isPatch)
    expect(patch!.args.slice(patch!.args.indexOf('--'))).toEqual(['--', ...['plain.txt', 'old name.txt', 'new name.txt', ':colon\tname.txt'].map(path => join(root, path))])
    expect(patch!.args).toContain('--unified=3')
  })

  it('reads every command of one call from one private copy of the index, and a staged diff against the commit it resolved once', async () => {
    const root = workspace()
    writeFileSync(join(root, '.git', 'index'), 'index-bytes')
    const oid = 'a'.repeat(40)
    const runProcess = scripted(request => {
      if (request.args[0] === 'rev-parse' && request.args.includes('--verify')) return { stdout: `${oid}\n` }
      return isListing(request) ? { stdout: listingOf(['M', ['plain.txt'], '1\t0']) } : null
    })
    await gitPack(root, runProcess)({ staged: true }, allowed)
    const requests = runProcess.mock.calls.map(([request]) => request)
    const later = requests.filter(request => ['diff', 'ls-files'].includes(request.args[0]!) || request.args.includes('--verify'))
    expect(later.map(request => request.args[0])).toEqual(['rev-parse', 'diff', 'ls-files', 'diff'])
    const index = later[0]!.environment.GIT_INDEX_FILE
    expect(index).toEqual(expect.any(String))
    expect(index).not.toBe(join(root, '.git', 'index'))
    for (const request of later) expect(request.environment.GIT_INDEX_FILE).toBe(index)
    for (const request of requests.filter(request => request.args[0] === 'diff')) {
      expect(request.args.slice(request.args.indexOf('--cached'), request.args.indexOf('--cached') + 2)).toEqual(['--cached', oid])
      expect(request.args).not.toContain('--staged')
      expect(request.args).toContain('--no-relative')
    }
  })

  // git compares the content of an entry no older than the index file (racy git); a copy timed at the copy read a
  // same-size change made in the moment of the index's last write as no change at all.
  it('copies the index with a time no later than the original\'s, and less than a millisecond earlier', async () => {
    const root = workspace()
    const index = join(root, '.git', 'index')
    writeFileSync(index, 'index-bytes')
    utimesSync(index, 1_577_836_800.123_456, 1_577_836_800.987_654)
    const seen: number[] = []
    const runProcess = scripted(request => {
      if (isListing(request)) seen.push(statSync(request.environment.GIT_INDEX_FILE!).mtimeMs)
      return isListing(request) ? { stdout: listingOf(['M', ['plain.txt'], '1\t0']) } : null
    })
    await gitPack(root, runProcess)({}, allowed)
    const original = statSync(index).mtimeMs
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeLessThanOrEqual(original)
    expect(original - seen[0]!).toBeLessThan(1)
  })

  it('hides a shown path that an entry of the index lies beneath, though the listing never named that entry', async () => {
    const root = workspace()
    const runProcess = scripted(request => {
      if (isListing(request)) return { stdout: listingOf(['M', ['a'], '1\t0'], ['M', ['b.txt'], '1\t0']) }
      return request.args[0] === 'ls-files' ? { stdout: 'a\0a/.env\0b.txt\0' } : null
    })
    const { diff } = await gitPack(root, runProcess)({}, allowed)
    expect(diff).toContain('diff --git a/a b/a\nstat: +1 -0\n[content hidden: hidden file beneath it]\n')
    const [patch] = runProcess.mock.calls.map(([request]) => request).filter(isPatch)
    expect(patch!.args.slice(patch!.args.indexOf('--'))).toEqual(['--', join(root, 'b.txt')])
  })

  it.each<[string, Partial<ProcessResult>]>([
    ['a listing that is not git\'s', { stdout: 'diff --git a/.env b/.env\n+NAME=x\n' }],
    ['a raw record with no numstat record', { stdout: ':100644 100644 1111111 0000000 M\0plain.txt\0' }],
    ['a numstat record naming another path', { stdout: ':100644 100644 1111111 0000000 M\x00plain.txt\x001\t0\t.env\x00' }],
    ['a listing cut short', { stdout: listingOf(['M', ['plain.txt'], '1\t0']), truncated: true }],
    ['a combined record', { stdout: '::100644 100644 100644 1111111 2222222 0000000 MM\0f\0' }],
  ])('refuses %s, showing nothing and running no patch', async (_, listing) => {
    const root = workspace()
    const runProcess = scripted(request => isListing(request) ? listing : null)
    const refusal = await gitPack(root, runProcess)({}, allowed).then(() => null, (error: unknown) => error)
    expect(refusal).toMatchObject({ code: 'GIT_FAILED' })
    expect(String(refusal)).not.toMatch(/NAME=x|\.env|plain\.txt/)
    expect(runProcess.mock.calls.map(([request]) => request).filter(isPatch)).toEqual([])
  })

  it.each([['a.txt\uFFFD'], ['a/../.env'], ['a\\b.txt'], ['./a.txt']])('hides a listed path %j that is not one plain name per folder', async path => {
    const root = workspace()
    const runProcess = scripted(request => isListing(request) ? { stdout: listingOf(['M', [path], '1\t0']) } : null)
    const { diff } = await gitPack(root, runProcess)({}, allowed)
    expect(diff).toContain('[content hidden: name Buckle cannot read]')
    expect(runProcess.mock.calls.map(([request]) => request).filter(isPatch)).toEqual([])
  })
})
