import { z } from 'zod'
import type { JsonValue } from '@5straps/protocol'
import { buildChildEnvironment } from '../../domain/environment.js'
import type { Pack } from '../../domain/pack.js'
import { defineTool, ToolExecutionError } from '../../domain/tool.js'
import type { ProcessRunner } from '../../ports/process-runner.js'
import { loadPackSkill } from '../pack-skill.js'
import { describeProcessFailure } from '../process-failure.js'

const PACK_ID = 'browser'

const commandInput = z.object({
  command: z.string().min(1).max(100),
  args: z.array(z.string().max(100_000)).max(200).default([]),
  session: z.string().min(1).max(200).optional(),
})

export interface BrowserPackOptions {
  cwd: string
  runProcess: ProcessRunner
  agentBrowserCommand: string
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
        effects: input => [{
          kind: 'exec',
          command: options.agentBrowserCommand,
          args: [input.command, ...input.args],
        }],
        run: async (input, context): Promise<JsonValue> => {
          // agent-browser takes the subcommand first; --json and --session are global flags.
          const args = [input.command, ...input.args, '--json']
          if (input.session) args.push('--session', input.session)

          const result = await options.runProcess({
            command: options.agentBrowserCommand,
            args,
            cwd: options.cwd,
            timeoutMs: context.timeoutMs,
            environment: buildChildEnvironment({ parent: process.env, extra: {} }),
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

/** Most agent-browser commands honour --json; a few (screenshot paths) print plain text. */
function parseJsonOutput(stdout: string): JsonValue {
  try {
    return JSON.parse(stdout) as JsonValue
  } catch {
    return stdout
  }
}
