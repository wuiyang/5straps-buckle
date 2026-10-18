import { basename, isAbsolute } from 'pathe'
import { z } from 'zod'
import type { HostEnvironment } from '../../../domain/environment.js'
import type { ResolvedProgram } from '../../../domain/executable.js'
import type { Pack } from '../../../domain/pack.js'
import { defineTool, ToolInputError } from '../../../domain/tool.js'
import type { ProcessRunner } from '../../../types/ports/process-runner.js'

/**
 * `command` is the validator as configured, which an exec rule judges; `validator` is that command resolved as every
 * program Buckle runs is (resolveProgram), refused in or through any root of the node an agent writes, whichever
 * workspace calls it, and spawned by its real path with the host program `environment`.
 */
export function createEnvironmentPack(input: { command: string; validator: ResolvedProgram; cwd: string; runProcess: ProcessRunner; environment: HostEnvironment }): Pack {
  return {
    id: 'environment', version: '1.0.0', skills: [], unavailableReason: null,
    tools: [defineTool('environment', {
      name: 'env_validate',
      description: 'Validate environment configuration with the owner-configured Varlock executable. Returns only validity; no values or validator output.',
      risk: 'execute', input: z.object({}).strict(),
      effects: () => [{ kind: 'exec', command: input.command, args: ['load', '--agent'], shownAs: basename(input.command) }],
      run: async (_args, context) => {
        if (!isAbsolute(input.command)) throw new ToolInputError('The owner must configure an absolute validator executable path')
        const { validator } = input
        if (validator.path === null) throw new ToolInputError(validator.reason, validator.untrusted ? { code: 'PERMISSION_DENIED' } : undefined)
        const result = await input.runProcess({
          command: validator.path, argv0: validator.argv0, args: [...validator.args, 'load', '--agent'], cwd: input.cwd, timeoutMs: context.timeoutMs,
          signal: context.signal, environment: input.environment(),
        })
        return { valid: result.exitCode === 0 && !result.timedOut, timedOut: result.timedOut }
      },
    })],
  }
}
