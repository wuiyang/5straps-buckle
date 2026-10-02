import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { buildChildEnvironment } from '../../../domain/environment.js'
import type { Pack } from '../../../domain/pack.js'
import { isInside } from '../../../domain/paths.js'
import { defineTool, ToolInputError } from '../../../domain/tool.js'
import type { ProcessRunner } from '../../../types/ports/process-runner.js'

export function createEnvironmentPack(input: { command: string; cwd: string; runProcess: ProcessRunner }): Pack {
  return {
    id: 'environment', version: '1.0.0', skills: [], unavailableReason: null,
    tools: [defineTool('environment', {
      name: 'env_validate',
      description: 'Validate environment configuration with the owner-configured Varlock executable. Returns only validity; no values or validator output.',
      risk: 'execute', input: z.object({}).strict(),
      effects: () => [{ kind: 'exec', command: input.command, args: ['load', '--agent'] }],
      run: async (_args, context) => {
        if (!isAbsolute(input.command)) throw new ToolInputError('The owner must configure an absolute validator executable path')
        const executable = await realpath(input.command)
        if (isInside(await realpath(input.cwd), executable)) throw new ToolInputError('The validator executable must be outside the agent workspace', { code: 'PERMISSION_DENIED' })
        const result = await input.runProcess({
          command: executable, args: ['load', '--agent'], cwd: input.cwd, timeoutMs: context.timeoutMs,
          signal: context.signal, environment: buildChildEnvironment({ parent: process.env, extra: {} }),
        })
        return { valid: result.exitCode === 0 && !result.timedOut, timedOut: result.timedOut }
      },
    })],
  }
}
