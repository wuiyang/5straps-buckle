import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { createJsonFileStore, type JsonFileStore } from '../../../adapters/json-file-store.js'
import type { JsonValue } from '@5straps/protocol'
import { buildChildEnvironment } from '../../../domain/environment.js'
import type { Pack } from '../../../domain/pack.js'
import type { PathView } from '../../../domain/path-view.js'
import { defineTool, ToolExecutionError, ToolInputError } from '../../../domain/tool.js'
import type { ProcessRunner } from '../../../types/ports/process-runner.js'
import { logger } from '../../../runtime/log.js'
import { loadPackSkill } from '../pack-skill.js'
import { browserAllowedDomains, type ApprovedList, type LoosenedEntry } from './allowed-domains.js'
import { argumentOrder, browserEffects, flagRefusal, navigationTargets, refusedFlag } from './effects.js'
import { describeProcessFailure } from '../process-failure.js'

const PACK_ID = 'browser'

const FRESH_COMMANDS = new Set(['open', 'snapshot', 'click', 'dblclick', 'fill', 'type', 'press', 'keydown', 'keyup', 'hover', 'focus', 'check', 'uncheck', 'select', 'scroll', 'scrollintoview', 'drag', 'upload', 'download', 'screenshot', 'pdf', 'get', 'is', 'wait', 'eval', 'back', 'forward', 'reload', 'tab', 'frame', 'dialog', 'console', 'errors', 'highlight', 'close', 'find', 'mouse', 'touch', 'set'])

/** Fixed text, so the agent reads the same sentence whichever browser was reset. */
const RELAUNCH_NOTICE = 'The browser was relaunched because the allowed domains changed; open tabs and cookies were reset.'

const SessionsSchema = z.object({
  sessions: z.record(z.string(), z.string()),
  /** The --allowed-domains each session last ran with, null for none, so a change can be told. */
  allowedDomains: z.record(z.string(), z.string().nullable()).default({}),
})

const commandInput = z.object({
  command: z.string().regex(/^[a-z][a-z0-9-]*$/).max(100),
  args: z.array(z.string().max(100_000)).max(200).default([]),
  session: z.string().min(1).max(200).optional(),
})

export interface BrowserPackOptions {
  cwd: string
  paths: PathView
  runProcess: ProcessRunner
  agentBrowserCommand: string
  /** Protected daemon mapping and configuration, never a browser profile. */
  sessionDirectory: string
  /** Launch a visible window instead of headless. A per-call --headed flag still wins. */
  headed: boolean
  available: boolean
  /**
   * Each configured approved list, node ceiling first, empty when none is set. Passed on every
   * call as --allowed-domains, so clicks, redirects and page requests stay on their hosts too; the
   * pack is rebuilt when the policy changes, and agent-browser relaunches the browser when a call
   * brings a different list.
   */
  approvedLists: ApprovedList[]
}

/** Names the setting, never its value, which can be a path outside the workspace. */
export const BROWSER_UNAVAILABLE = 'agent-browser is not installed on this node, or BUCKLE_AGENT_BROWSER_COMMAND does not name it'

export function createBrowserPack(options: BrowserPackOptions): Pack {
  const sessions = createJsonFileStore({ filePath: join(options.sessionDirectory, 'sessions.json'), schema: SessionsSchema, fallback: { sessions: {}, allowedDomains: {} } })
  const configFile = join(options.sessionDirectory, 'fresh-config.json')
  const allowedDomains = browserAllowedDomains(options.approvedLists)
  const flag = 'value' in allowedDomains ? allowedDomains.value : null
  // The browser daemons this pack started and has not closed, which outlive single calls.
  const opened = new Set<string>()
  return {
    id: PACK_ID,
    version: '1.0.0',
    skills: [loadPackSkill(PACK_ID)],
    // Fixed text: the manifest carrying it is read with the agent token, and the configured path is the owner's.
    unavailableReason: options.available ? null : BROWSER_UNAVAILABLE,
    close: () => closeSessions({ options, sessions, opened }),
    tools: [
      defineTool(PACK_ID, {
        name: 'browser_command',
        description: 'Run one agent-browser command against an isolated browser session; close discards browser state.',
        risk: 'execute',
        tags: ['browser', 'agent-browser', 'network'],
        input: commandInput,
        effects: input => {
          // Before anything is judged, so the owner is never asked about a browser that cannot start.
          if ('refusal' in allowedDomains) throw new ToolInputError(allowedDomains.refusal, { code: 'PERMISSION_DENIED' })
          return [
            { kind: 'exec', command: options.agentBrowserCommand, args: [input.command, ...input.args] },
            ...browserEffects(input.command, input.args),
          ]
        },
        run: async (input, context): Promise<JsonValue> => {
          const forbidden = ['--session', '--namespace', '--restore', '--restore-save', '--state', '--load', '--credential-provider', '--action-policy']
          if ((!FRESH_COMMANDS.has(input.command) || input.args.some(arg => forbidden.includes(arg.split('=')[0]!)))) throw new ToolInputError('Fresh browsers cannot attach, restore, or override session identity')
          const refused = refusedFlag(input.args)
          if (refused) throw new ToolInputError(flagRefusal(refused))

          // Resolve file arguments against the authorized workspace, not the daemon state directory.
          const filePaths = new Set(browserEffects(input.command, input.args).flatMap(effect => effect.kind === 'read_path' || effect.kind === 'write_path' ? [effect.path] : []))
          if (['screenshot', 'pdf', 'download', 'upload'].includes(input.command) && !filePaths.size) throw new ToolInputError('Browser file operations require an explicit path')
          const targets = navigationTargets(input.command, input.args)
          const passed = input.args.map((argument, index) => targets.get(index) ?? (filePaths.has(argument) ? options.paths.resolve(argument) : realPath(argument, options.paths)))
          const args = [input.command, ...argumentOrder(input.command, input.args).map(index => passed[index]!), '--json']
          const key = JSON.stringify([context.sessionId, context.stageId ?? 'default', input.session ?? 'default'])
          const { session, previous } = await sessions.update(state => ({ session: state.sessions[key] ??= `buckle-${randomUUID()}`, previous: state.allowedDomains[key] }))
          args.push('--config', configFile, '--session', session, '--idle-timeout', '300000')
          if (flag !== null) args.push('--allowed-domains', flag)
          if ('loosened' in allowedDomains) logLoosened(allowedDomains.loosened)
          if (options.headed && !input.args.includes('--headed')) args.push('--headed')

          mkdirSync(options.sessionDirectory, { recursive: true, mode: 0o700 })
          writeFileSync(configFile, '{}\n', { mode: 0o600 })
          const result = await options.runProcess({
            command: options.agentBrowserCommand,
            args,
            cwd: options.sessionDirectory,
            timeoutMs: context.timeoutMs,
            environment: buildChildEnvironment({ parent: process.env, extra: {} }),
            signal: context.signal,
          })
          if (result.exitCode !== 0) {
            throw new ToolExecutionError(describeProcessFailure('agent-browser', result), { code: 'BROWSER_COMMAND_FAILED' })
          }
          if (input.command === 'close') {
            opened.delete(session)
            await sessions.update(state => { delete state.sessions[key]; delete state.allowedDomains[key] })
          } else {
            opened.add(session)
            await sessions.update(state => { state.allowedDomains[key] = flag })
          }
          const relaunched = input.command !== 'close' && previous !== undefined && previous !== flag
          if (relaunched) logger.warn('Browser relaunched because its allowed domains changed', { previous: previous ?? 'none', current: flag ?? 'none' })
          return { result: parseJsonOutput(result.stdout), stderr: result.stderr, truncated: result.truncated, ...(relaunched ? { notice: RELAUNCH_NOTICE } : {}) }
        },
      }),
    ],
  }
}

/** How long shutdown waits for one browser daemon to close. */
const CLOSE_TIMEOUT_MS = 5_000

/**
 * At shutdown: closes each browser this pack started, as the close command would, and forgets its
 * session, so no daemon outlives the node by its idle timeout. A daemon that will not close is left
 * to that timeout, with a warning.
 */
async function closeSessions(input: { options: BrowserPackOptions; sessions: JsonFileStore<z.infer<typeof SessionsSchema>>; opened: Set<string> }): Promise<void> {
  const closing = [...input.opened]
  input.opened.clear()
  for (const session of closing) {
    const result = await input.options.runProcess({
      command: input.options.agentBrowserCommand,
      args: ['close', '--session', session, '--json'],
      cwd: input.options.sessionDirectory,
      timeoutMs: CLOSE_TIMEOUT_MS,
      environment: buildChildEnvironment({ parent: process.env, extra: {} }),
      signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS),
    }).catch((error: unknown) => ({ exitCode: null, error }))
    if (result.exitCode !== 0) logger.warn('A browser session did not close at shutdown; its idle timeout ends it', { exitCode: result.exitCode })
  }
  if (closing.length === 0) return
  await input.sessions.update((state) => {
    for (const [key, session] of Object.entries(state.sessions)) {
      if (!closing.includes(session)) continue
      delete state.sessions[key]
      delete state.allowedDomains[key]
    }
  })
}

const loggedLoosened = new Set<string>()

/** At the first browser call rather than at pack build, which every CLI command does; once per process for each set. */
function logLoosened(loosened: LoosenedEntry[]): void {
  const described = loosened.map(item => `${item.entry} (${item.list} list) as ${item.host}`).join(', ')
  if (!described || loggedLoosened.has(described)) return
  loggedLoosened.add(described)
  logger.info('The browser is held to these approved hosts on any port and path; Buckle still judges the page a command names by port and path', { loosened: described })
}

function realPath(argument: string, paths: PathView): string {
  if (argument.startsWith('-') || !paths.mount) return argument
  return argument === paths.mount || argument.startsWith(`${paths.mount}/`) ? paths.resolve(argument) : argument
}

/** Most agent-browser commands honour --json; a few (screenshot paths) print plain text. */
function parseJsonOutput(stdout: string): JsonValue {
  try {
    return JSON.parse(stdout) as JsonValue
  } catch {
    return stdout
  }
}
