import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { expect, inject } from 'vitest'
import { packageRoot } from './paths.js'

export interface LogLine {
  level: string
  component: string
  message: string
  correlationId?: string
  fields?: Record<string, unknown>
  error?: { name: string; message: string }
}

export interface FixtureTokens {
  agent: string
  admin: string
}

export interface FixtureProcess {
  child: ChildProcess
  stdout: Record<string, unknown>[]
  events: LogLine[]
  malformed: string[]
  exited: Promise<number | null>
  waitFor(message: string, predicate?: (event: LogLine) => boolean, timeoutMs?: number): Promise<LogLine>
  stop(signal?: NodeJS.Signals): Promise<number | null>
}

export interface ServingFixture extends FixtureProcess {
  port: number
  url(path: string): string
}

export function createTokens(): FixtureTokens {
  return { agent: randomBytes(24).toString('hex'), admin: randomBytes(24).toString('hex') }
}

export function createDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'fixture-data-'))
}

export function fixtureEnv(input: { dataDir: string; tokens: FixtureTokens; entry?: string; extra?: Record<string, string> }): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: input.dataDir,
    TMPDIR: tmpdir(),
    FIXTURE_DATA_DIR: input.dataDir,
    FIXTURE_AGENT_TOKEN: input.tokens.agent,
    FIXTURE_ADMIN_TOKEN: input.tokens.admin,
    ...(input.entry ? { FIXTURE_ENTRY: input.entry } : {}),
    ...input.extra,
  }
}

// Runs main.ts from the fixture copy the global setup built; cwd stays packageRoot so tsx reads the package tsconfig.
export function startFixture(input: { args: string[]; env: NodeJS.ProcessEnv; stdio?: StdioOptions }): FixtureProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', inject('fixtureBuild').main, ...input.args], { cwd: packageRoot, env: input.env, stdio: input.stdio ?? ['ignore', 'pipe', 'pipe'] })
  const stdout: Record<string, unknown>[] = []
  const events: LogLine[] = []
  const malformed: string[] = []
  const watchers = new Set<() => void>()
  const notify = () => watchers.forEach(watch => watch())
  createInterface({ input: child.stdout! }).on('line', (line) => {
    const parsed = parseObject(line)
    if (parsed) stdout.push(parsed)
    else malformed.push(`stdout: ${line}`)
    notify()
  })
  createInterface({ input: child.stderr! }).on('line', (line) => {
    const parsed = parseObject(line)
    if (parsed && typeof parsed.message === 'string' && typeof parsed.level === 'string') events.push(parsed as unknown as LogLine)
    else malformed.push(`stderr: ${line}`)
    notify()
  })
  // 'close' rather than 'exit': the stdio pipes and process handle are released by then.
  let exitCode: number | null | undefined
  const exited = new Promise<number | null>(resolve => child.once('close', (code) => { exitCode = code; notify(); resolve(code) }))

  function waitFor(message: string, predicate: (event: LogLine) => boolean = () => true, timeoutMs = 15_000): Promise<LogLine> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const found = events.find(event => event.message === message && predicate(event))
        if (found) return finish(() => resolve(found))
        if (exitCode !== undefined) finish(() => reject(new Error(`fixture exited (${exitCode}) before "${message}":\n${describe()}`)))
      }
      const timer = setTimeout(() => finish(() => reject(new Error(`timed out waiting for "${message}":\n${describe()}`))), timeoutMs)
      const finish = (settle: () => void) => { clearTimeout(timer); watchers.delete(check); settle() }
      watchers.add(check)
      check()
    })
  }

  function describe(): string {
    return [...events.map(event => JSON.stringify(event)), ...malformed].slice(-40).join('\n')
  }

  return {
    child,
    stdout,
    events,
    malformed,
    exited,
    waitFor,
    async stop(signal = 'SIGTERM') {
      if (exitCode === undefined) child.kill(signal)
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
      try { return await exited } finally { clearTimeout(timer) }
    },
  }
}

export async function serveFixture(input: { entry: string; dataDir: string; tokens: FixtureTokens; extra?: Record<string, string> }): Promise<ServingFixture> {
  const fixture = startFixture({ args: ['serve'], env: fixtureEnv(input) })
  const listening = await fixture.waitFor('listening')
  const port = Number(listening.fields?.port)
  return { ...fixture, port, url: path => `http://127.0.0.1:${port}${path}` }
}

export async function runFixtureCli(input: { dataDir: string; tokens: FixtureTokens; args: string[] }): Promise<{ code: number | null; output: Record<string, unknown>; process: FixtureProcess }> {
  const fixture = startFixture({ args: ['cli', ...input.args], env: fixtureEnv(input) })
  const code = await fixture.exited
  return { code, output: fixture.stdout.at(-1) ?? {}, process: fixture }
}

// Pass condition for every fixture run: stdout carries only machine lines, stderr only JSON diagnostics.
export function expectCleanDiagnostics(fixture: FixtureProcess): void {
  expect(fixture.malformed).toEqual([])
  expect(fixture.events.filter(event => event.message === 'unhandled rejection' || event.level === 'fatal')).toEqual([])
}

export function bearer(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...extra }
}

function parseObject(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}
