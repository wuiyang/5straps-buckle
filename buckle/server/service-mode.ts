import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'pathe'
import { parseArgs } from 'node:util'
import { SKIP_OWNER_ONLY_FLAG } from '../common/adapters/file-modes.js'
import { addressOf, attachCommand, besideService } from '../common/services/node-service/attach.js'
import { runningNode, SERVICE_MANAGERS, waitForRecord, type ServiceManagerKind } from '../common/services/node-service/serve-record.js'
import type { NodeLocation } from '../common/types/ports/service-manager.js'

/** How `buckle serve` was asked to run (Phase 3, item 1). */
export interface ServeOptions {
  help: boolean
  /** Start a serving process detached from this terminal, and return once it listens. */
  background: boolean
  /** What started this process to run with no terminal; null for a serve at a terminal. */
  service: ServiceManagerKind | null
  /** Where a service definition says the node lives; only with --service, so a terminal's serve reads its environment. */
  location: Partial<NodeLocation>
}

export const SERVE_USAGE = `Usage: buckle serve [--background]

Serves every online workspace over HTTP, native RPC, and MCP, at BUCKLE_HOST and BUCKLE_PORT (127.0.0.1:4320 by
default). An agent's token chooses its workspace. In a terminal it lists the workspaces it serves and asks each
approval there. Ctrl-C stops it.

--background starts the node detached from this terminal, logging to the state directory's logs/buckle.log, prints
its pid, and returns; buckle approvals --watch answers its approvals, and buckle service stop stops it. buckle service
install runs it at every login instead.
`

const BACKGROUND_START_MS = 30_000

export function parseServeOptions(options: readonly string[]): ServeOptions {
  let parsed: ReturnType<typeof parseServeArguments>
  try { parsed = parseServeArguments(options) } catch (error) {
    if (error instanceof TypeError && String((error as { code?: unknown }).code).startsWith('ERR_PARSE_ARGS')) throw new Error(`${error.message.split('. ')[0]}\n${SERVE_USAGE}`)
    throw error
  }
  const { values } = parsed
  const service = values.service ?? null
  if (service !== null && !(SERVICE_MANAGERS as readonly string[]).includes(service)) throw new Error(`--service takes ${SERVICE_MANAGERS.join(', ')}; a service definition passes it, not a person`)
  if (service === null && (values['state-dir'] !== undefined || values['env-file'] !== undefined)) {
    throw new Error('--state-dir and --env-file are what a service definition passes; at a terminal, set BUCKLE_STATE_DIR or BUCKLE_ENV_FILE instead')
  }
  for (const [flag, value] of [['--state-dir', values['state-dir']], ['--env-file', values['env-file']]] as const) {
    if (value !== undefined && !isAbsolute(value)) throw new Error(`${flag} must be an absolute path`)
  }
  return {
    help: values.help === true,
    background: values.background === true,
    service: service as ServiceManagerKind | null,
    location: { ...(values['state-dir'] === undefined ? {} : { stateDirectory: values['state-dir'] }), ...(values['env-file'] === undefined ? {} : { environmentFile: values['env-file'] }) },
  }
}

function parseServeArguments(options: readonly string[]) {
  return parseArgs({
    args: [...options],
    options: { help: { type: 'boolean', short: 'h' }, background: { type: 'boolean' }, service: { type: 'string' }, 'state-dir': { type: 'string' }, 'env-file': { type: 'string' } },
    allowPositionals: false,
  })
}

/**
 * Sets where the node lives, as a service definition names it, before anything reads the environment: the state
 * directory and the environment file, paths alone. A terminal's serve reads its own environment instead.
 */
export function useServiceLocation(location: Partial<NodeLocation>, environment: NodeJS.ProcessEnv = process.env): void {
  if (location.stateDirectory !== undefined) environment.BUCKLE_STATE_DIR = location.stateDirectory
  if (location.environmentFile) environment.BUCKLE_ENV_FILE = location.environmentFile
}

/**
 * `buckle serve --background` (Phase 3, item 1), run before buckle.env is read: starts a serving process detached from
 * this terminal, with no window on Windows, waits until it listens and records its pid under the state directory, then
 * prints the pid and the command that answers its approvals. A node already serving there with no terminal refuses it
 * (item 5). The child reads buckle.env itself, as any serve does; this process passes it only the environment it was
 * started with, and the node's location as paths.
 */
export async function startInBackground(input: { options: ServeOptions; location: NodeLocation; mainScript: string; skipOwnerOnlyCheck: boolean; environment?: NodeJS.ProcessEnv; cwd?: string; platform?: NodeJS.Platform }): Promise<{ exitCode: number; message: string }> {
  const environment = input.environment ?? process.env
  const cwd = input.cwd ?? process.cwd()
  const { location } = input
  const running = await runningNode(location.stateDirectory)
  if (running !== null) return { exitCode: 1, message: besideService({ running, command: 'buckle serve --background', stateDirectory: location.stateDirectory, cwd, platform: input.platform }) }
  if (!existsSync(input.mainScript)) return { exitCode: 1, message: 'buckle serve --background runs the built Buckle, and this copy has no dist/main.js: build it first with pnpm build.' }
  const args = [input.mainScript, 'serve', '--service', input.options.service ?? 'background', '--state-dir', location.stateDirectory,
    ...(location.environmentFile ? ['--env-file', location.environmentFile] : []), ...(input.skipOwnerOnlyCheck ? [SKIP_OWNER_ONLY_FLAG] : [])]
  let exit: number | null | undefined
  const child = spawn(process.execPath, args, { cwd, env: environment, detached: true, stdio: 'ignore', windowsHide: true })
  const failed = new Promise<Error>(resolve => child.once('error', resolve))
  child.once('exit', code => { exit = code })
  const record = child.pid === undefined ? null : await waitForRecord({ stateDirectory: location.stateDirectory, pid: child.pid, timeoutMs: BACKGROUND_START_MS, gone: () => exit !== undefined })
  child.unref()
  if (child.pid === undefined) return { exitCode: 1, message: `Buckle could not start in the background: ${(await failed).message}` }
  if (record === null) {
    return exit === undefined
      ? { exitCode: 1, message: `Buckle started in the background (pid ${child.pid}) and has not listened within ${BACKGROUND_START_MS / 1000} seconds; buckle service status and buckle service logs show what it is doing.` }
      : { exitCode: 1, message: `Buckle did not start in the background (exit code ${exit}); buckle service logs shows why.` }
  }
  return { exitCode: 0, message: `Buckle runs in the background (pid ${record.pid}) at ${addressOf(record)}. Answer its approvals with ${attachCommand(location.stateDirectory, cwd, input.platform)}; stop it with buckle service stop.` }
}
