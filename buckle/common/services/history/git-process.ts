import { spawn, type ChildProcess } from 'node:child_process'
import { constants as systemConstants } from 'node:os'
import { performance } from 'node:perf_hooks'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'pathe'
import { resolveProgram, rootsOf, type Program, type UntrustedRoots } from '../../domain/executable.js'
import { logger } from '../../runtime/log.js'

const GIT_OPERATIONS = ['init', 'ls-files', 'update-index', 'add', 'read-tree', 'write-tree', 'commit-tree', 'ls-tree', 'check-ignore', 'cat-file', 'update-ref', 'diff-tree', 'checkout-index', 'for-each-ref', 'rev-parse', 'verify-pack', 'rev-list', 'gc', 'repack', 'diff-files'] as const
export type GitOperation = typeof GIT_OPERATIONS[number] | 'unknown'
type GitFailure = 'start' | 'timeout' | 'output-limit' | 'exit' | 'aborted'
interface GitFailureDetails { operation: GitOperation; failure: GitFailure; elapsedMs: number; exitCode?: number; errno?: string }

export class HistoryGitError extends Error {
  override readonly name = 'HistoryGitError'
  constructor(readonly details: GitFailureDetails) { super(`History git ${details.operation} failed (${details.failure}); inspect the checkpoint and retry`) }
}

export function historyGitProgram(input: { allowed: boolean; roots: string[]; untrusted?: UntrustedRoots }): Program | null {
  if (!input.allowed) return null
  const found = resolveProgram('git', { ...input.untrusted, untrustedRoots: [...input.untrusted?.untrustedRoots ?? [], ...rootsOf('workspace', input.roots)] })
  return found.path === null ? null : found
}

/**
 * How every history git child runs, from `owned`, a folder only Buckle writes: no system or global config, no hooks,
 * fsmonitor, filters, prompts, or lazy fetch, no automatic gc or maintenance, and the workspace's own config never read.
 * `empty` is the empty template and hooks folder, `config` the empty file git reads as its global config.
 */
export function isolatedGit(owned: string): { environment: Record<string, string>; safety: string[]; empty: string } {
  mkdirSync(owned, { recursive: true, mode: 0o700 })
  const empty = join(owned, 'empty'); mkdirSync(empty, { recursive: true, mode: 0o700 })
  const config = join(owned, 'config'); writeFileSync(config, '', { mode: 0o600 })
  const safeEnv = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TMP', 'TEMP', 'TMPDIR'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]))
  const environment = { ...safeEnv, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_PAGER: '', GIT_ATTR_NOSYSTEM: '1', GIT_LITERAL_PATHSPECS: '1', GIT_AUTHOR_NAME: 'Buckle history', GIT_AUTHOR_EMAIL: 'history@buckle.invalid', GIT_COMMITTER_NAME: 'Buckle history', GIT_COMMITTER_EMAIL: 'history@buckle.invalid' }
  const safety = ['-c', `core.hooksPath=${empty}`, '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.ignoreStat=false', '-c', 'core.trustctime=true', '-c', 'core.untrackedCache=false', '-c', 'commit.gpgSign=false', '-c', 'gc.auto=0', '-c', 'gc.writeCommitGraph=false', '-c', 'core.commitGraph=false', '-c', 'maintenance.auto=false', '-c', 'submodule.recurse=false', '-c', 'protocol.allow=never', '-c', `core.attributesFile=${config}`, '-c', 'core.fileMode=true', '-c', 'core.symlinks=true']
  return { environment, safety, empty }
}

export function gitOperation(args: string[]): GitOperation {
  let index = 0
  while (args[index] === '-c') index += 2
  return GIT_OPERATIONS.find(operation => operation === args[index]) ?? 'unknown'
}
function safeErrno(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' && Object.hasOwn(systemConstants.errno, error.code) ? error.code : undefined
}
/**
 * Runs one git child and answers its stdout. `timeoutMs` (10 s unless given) stops it, and so does `signal` (X14); a
 * timer or a cancellation never releases the caller while the child can still write.
 */
/** `errors`: given, each chunk git writes to stderr, which is otherwise dropped; the caller bounds what it keeps. */
export function runProgram(input: { program: Program; operation: GitOperation; args: string[]; cwd: string; environment: NodeJS.ProcessEnv; data?: string | Buffer; acceptedCodes?: number[]; timeoutMs?: number; signal?: AbortSignal; errors?: (chunk: Buffer) => void }): Promise<Buffer> {
  const started = performance.now()
  const details = (failure: GitFailure, code?: number | null, errno?: string): GitFailureDetails => ({ operation: input.operation, failure, elapsedMs: Math.round(performance.now() - started), ...(code !== null && code !== undefined && Number.isSafeInteger(code) && code >= 0 ? { exitCode: code } : {}), ...(errno ? { errno } : {}) })
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try { child = spawn(input.program.path, [...input.program.args, ...input.args], { argv0: input.program.argv0, cwd: input.cwd, env: input.environment, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) }
    catch (error) { reject(new HistoryGitError(details('start', undefined, safeErrno(error)))); return }
    const output: Buffer[] = []; let bytes = 0
    let failure: GitFailure | undefined; let errno: string | undefined
    let force: ReturnType<typeof setTimeout> | undefined
    const signal = (value: NodeJS.Signals): void => { try { child.kill(value) } catch (error) { errno ??= safeErrno(error) } }
    const stop = (reason: 'timeout' | 'output-limit' | 'aborted'): void => {
      if (failure) return
      failure = reason
      signal('SIGTERM')
      force = setTimeout(() => { logger.warn('History waits for Git exit before continuing', { ...details(reason, undefined, errno) }); signal('SIGKILL') }, 1_000)
    }
    const timeout = setTimeout(() => stop('timeout'), input.timeoutMs ?? 10_000)
    const abort = (): void => stop('aborted')
    if (input.signal?.aborted) abort()
    else input.signal?.addEventListener('abort', abort, { once: true })
    child.stdout!.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 64 * 1_048_576) stop('output-limit'); else output.push(chunk) })
    if (input.errors) child.stderr!.on('data', input.errors)
    else child.stderr!.resume()
    child.on('error', error => { failure ??= 'start'; errno ??= safeErrno(error) })
    // A timer must never release the mutation lock while Git can still write.
    child.on('close', code => {
      clearTimeout(timeout); clearTimeout(force); input.signal?.removeEventListener('abort', abort)
      if (!failure && code !== null && (input.acceptedCodes ?? [0]).includes(code)) resolve(Buffer.concat(output))
      else reject(new HistoryGitError(details(failure ?? 'exit', code, errno)))
    })
    child.stdin!.on('error', () => undefined)
    child.stdin!.end(input.data)
  })
}
