import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { createJsonFileStore } from '../../adapters/json-file-store.js'
import type { JsonValue } from '@5straps/protocol'
import { buildChildEnvironment } from '../../domain/environment.js'
import type { Pack } from '../../domain/pack.js'
import type { PathView } from '../../domain/path-view.js'
import { defineTool, ToolExecutionError, ToolInputError } from '../../domain/tool.js'
import type { ProcessRunner } from '../../ports/process-runner.js'
import { loadPackSkill } from '../pack-skill.js'
import { browserEffects, refusedFlag } from './effects.js'
import { describeProcessFailure } from '../process-failure.js'

const PACK_ID = 'browser'

const FRESH_COMMANDS = new Set(['open', 'snapshot', 'click', 'dblclick', 'fill', 'type', 'press', 'keydown', 'keyup', 'hover', 'focus', 'check', 'uncheck', 'select', 'scroll', 'scrollintoview', 'drag', 'upload', 'download', 'screenshot', 'pdf', 'get', 'is', 'wait', 'eval', 'back', 'forward', 'reload', 'tab', 'frame', 'dialog', 'console', 'errors', 'highlight', 'close', 'find', 'mouse', 'touch', 'set'])

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
}

export function createBrowserPack(options: BrowserPackOptions): Pack {
  const sessions = createJsonFileStore({ filePath: join(options.sessionDirectory, 'sessions.json'), schema: z.object({ sessions: z.record(z.string(), z.string()) }), fallback: { sessions: {} } })
  const configFile = join(options.sessionDirectory, 'fresh-config.json')
  return {
    id: PACK_ID,
    version: '1.0.0',
    skills: [loadPackSkill(PACK_ID)],
    unavailableReason: options.available ? null : `${options.agentBrowserCommand} is not installed on this node`,
    tools: [
      defineTool(PACK_ID, {
        name: 'browser_command',
        description: 'Run one agent-browser command against an isolated browser session; close discards browser state.',
        risk: 'execute',
        tags: ['browser', 'agent-browser', 'network'],
        input: commandInput,
        effects: input => [
          { kind: 'exec', command: options.agentBrowserCommand, args: [input.command, ...input.args] },
          ...browserEffects(input.command, input.args),
        ],
        run: async (input, context): Promise<JsonValue> => {
          const forbidden = ['--session', '--namespace', '--restore', '--restore-save', '--state', '--load', '--credential-provider', '--action-policy']
          if ((!FRESH_COMMANDS.has(input.command) || input.args.some(arg => forbidden.includes(arg.split('=')[0]!)))) throw new ToolInputError('Fresh browsers cannot attach, restore, or override session identity')
          const refused = refusedFlag(input.args)
          if (refused) {
            throw new ToolInputError(`${refused} is not allowed: Buckle passes only the agent-browser flags it can judge, and never one that changes the profile, the binary, or where output lands`)
          }

          // Resolve file arguments against the authorized workspace, not the daemon state directory.
          const filePaths = new Set(browserEffects(input.command, input.args).flatMap(effect => effect.kind === 'read_path' || effect.kind === 'write_path' ? [effect.path] : []))
          if (['screenshot', 'pdf', 'download', 'upload'].includes(input.command) && !filePaths.size) throw new ToolInputError('Browser file operations require an explicit path')
          const args = [input.command, ...input.args.map(argument => filePaths.has(argument) ? options.paths.resolve(argument) : realPath(argument, options.paths)), '--json']
          const key = JSON.stringify([context.sessionId, context.stageId ?? 'default', input.session ?? 'default'])
          const session = sessions.update(state => state.sessions[key] ??= `buckle-${randomUUID()}`)
          args.push('--config', configFile, '--session', session, '--idle-timeout', '300000')
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
          if (input.command === 'close') sessions.update(state => { delete state.sessions[key] })
          return { result: parseJsonOutput(result.stdout), stderr: result.stderr, truncated: result.truncated }
        },
      }),
    ],
  }
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
