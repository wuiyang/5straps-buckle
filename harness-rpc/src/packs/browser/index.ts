import { z } from 'zod'
import type { JsonValue } from '@5straps/protocol'
import { buildChildEnvironment, collectPrefixed } from '../../domain/environment.js'
import type { Pack } from '../../domain/pack.js'
import type { PathView } from '../../domain/path-view.js'
import { defineTool, ToolExecutionError, ToolInputError } from '../../domain/tool.js'
import type { ProcessRunner } from '../../ports/process-runner.js'
import { loadPackSkill } from '../pack-skill.js'
import { browserEffects, refusedFlag } from './effects.js'
import { describeProcessFailure } from '../process-failure.js'

const PACK_ID = 'browser'

/**
 * agent-browser is configured almost entirely through these, and the child environment allowlist
 * would otherwise strip every one. Forwarding the prefix keeps that configuration working without
 * widening what any other pack inherits.
 */
const CONFIG_PREFIX = 'AGENT_BROWSER_'

const commandInput = z.object({
  command: z.string().min(1).max(100),
  args: z.array(z.string().max(100_000)).max(200).default([]),
  session: z.string().min(1).max(200).optional(),
})

export interface BrowserPackOptions {
  cwd: string
  paths: PathView
  runProcess: ProcessRunner
  agentBrowserCommand: string
  /** The profile Buckle owns for this workspace, passed on every call. */
  profileDirectory: string
  /** Launch a visible window instead of headless. A per-call --headed flag still wins. */
  headed: boolean
  available: boolean
}

export function createBrowserPack(options: BrowserPackOptions): Pack {
  return {
    id: PACK_ID,
    version: '1.0.0',
    skills: [loadPackSkill(PACK_ID)],
    unavailableReason: options.available ? null : `${options.agentBrowserCommand} is not installed on this node`,
    tools: [
      defineTool(PACK_ID, {
        name: 'browser_command',
        description: 'Run one agent-browser command against a persistent browser session.',
        risk: 'execute',
        tags: ['browser', 'agent-browser', 'network'],
        input: commandInput,
        effects: input => [
          { kind: 'exec', command: options.agentBrowserCommand, args: [input.command, ...input.args] },
          ...browserEffects(input.command, input.args),
        ],
        run: async (input, context): Promise<JsonValue> => {
          const refused = refusedFlag(input.args)
          if (refused) {
            throw new ToolInputError(`${refused} is not allowed: Buckle passes only the agent-browser flags it can judge, and never one that changes the profile, the binary, or where output lands`)
          }

          // agent-browser takes the subcommand first; --json, --profile, --headed and --session
          // are global flags. A path the agent named under the mount is handed over as the real one.
          const args = [input.command, ...input.args.map(argument => realPath(argument, options.paths)), '--json']
          args.push('--profile', options.profileDirectory)
          if (options.headed && !input.args.includes('--headed')) args.push('--headed')
          if (input.session) args.push('--session', input.session)

          const result = await options.runProcess({
            command: options.agentBrowserCommand,
            args,
            cwd: options.cwd,
            timeoutMs: context.timeoutMs,
            environment: buildChildEnvironment({ parent: process.env, extra: browserSettings(process.env) }),
            signal: context.signal,
          })
          if (result.exitCode !== 0) {
            throw new ToolExecutionError(describeProcessFailure('agent-browser', result), { code: 'BROWSER_COMMAND_FAILED' })
          }
          return { result: parseJsonOutput(result.stdout), stderr: result.stderr, truncated: result.truncated }
        },
      }),
    ],
  }
}

/** The tool's own settings, minus the profile: that one Buckle owns, and the flag carries it. */
function browserSettings(parent: NodeJS.ProcessEnv): Record<string, string> {
  const settings = collectPrefixed(parent, CONFIG_PREFIX)
  delete settings[`${CONFIG_PREFIX}PROFILE`]
  return settings
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
