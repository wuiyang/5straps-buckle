import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const PACKAGE = fileURLToPath(new URL('../..', import.meta.url))
// Under node_modules, so the built files resolve the installed dependencies like the package does.
const BUILDS = join(PACKAGE, 'node_modules', '.cache', 'buckle-test')

export interface LogLine {
  level: string
  message: string
  component?: string
  fields?: Record<string, unknown>
  error?: { name: string; message: string }
}

export interface BuckleProcess {
  readonly child: ChildProcess
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  stderr(): string
  /** Structured stderr lines; other text (a stack trace) is skipped. */
  lines(): LogLine[]
  waitForLine(predicate: (line: LogLine) => boolean, timeoutMs?: number): Promise<LogLine>
}

/** Builds the package with its own build script into a fresh directory; returns that directory. */
export function buildBuckle(): string {
  mkdirSync(BUILDS, { recursive: true })
  const outDir = mkdtempSync(join(BUILDS, 'dist-'))
  execFileSync(process.execPath, ['scripts/build.mjs', '--out-dir', outDir], { cwd: PACKAGE, stdio: 'pipe' })
  return outDir
}

export function removeBuild(outDir: string): void {
  rmSync(outDir, { recursive: true, force: true })
}

export function spawnBuckle(input: { entry: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; stdin?: 'pipe' | 'ignore' }): BuckleProcess {
  const child = spawn(process.execPath, [input.entry, ...input.args], { cwd: input.cwd, env: input.env, stdio: [input.stdin ?? 'ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  child.stdout!.resume()
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  const lines = () => stderr.split('\n').flatMap(parseLine)
  return {
    child,
    exited,
    stderr: () => stderr,
    lines,
    async waitForLine(predicate, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const found = lines().find(predicate)
        if (found) return found
        if (child.exitCode !== null) break
        await delay(20)
      }
      throw new Error(`No matching log line; stderr was:\n${stderr}`)
    },
  }
}

/** Polls until the node answers (any status) and returns that first response. */
export async function firstResponse(url: string, timeoutMs = 20_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) }).catch(() => null)
    if (response) return response
    await delay(20)
  }
  throw new Error(`${url} never answered`)
}

export async function waitForStatus(url: string, status: number, timeoutMs = 20_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) }).catch(() => null)
    if (response?.status === status) return response
    await delay(20)
  }
  throw new Error(`${url} never answered ${status}`)
}

export async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  await new Promise<void>(resolve => server.close(() => resolve()))
  return address.port
}

function parseLine(text: string): LogLine[] {
  if (!text.startsWith('{')) return []
  try {
    const value = JSON.parse(text) as LogLine
    return typeof value.message === 'string' ? [value] : []
  } catch {
    return []
  }
}
