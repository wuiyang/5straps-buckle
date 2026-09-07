import { z } from 'zod'
import type { JsonValue } from '@5straps/protocol'
import { buildChildEnvironment } from '../../domain/environment.js'
import type { Pack } from '../../domain/pack.js'
import type { PathView } from '../../domain/path-view.js'
import { defineTool } from '../../domain/tool.js'
import type { ProcessRunner, ProcessResult } from '../../ports/process-runner.js'
import type { Sandbox } from '../../ports/sandbox.js'
import { loadPackSkill } from '../pack-skill.js'

const PACK_ID = 'shell'

const RUNTIMES = {
  bash: (script: string) => ({ command: 'bash', args: ['-c', script] }),
  node: (script: string) => ({ command: process.execPath, args: ['--input-type=module', '--eval', script] }),
  python: (script: string) => ({ command: 'python3', args: ['-c', script] }),
}

const execInput = z.object({
  command: z.string().min(1).max(1_000),
  args: z.array(z.string().max(100_000)).max(1_000).default([]),
  cwd: z.string().default('.'),
  env: z.record(z.string(), z.string()).default({}),
  allowNetwork: z.boolean().default(true),
})

const scriptInput = z.object({
  runtime: z.enum(['bash', 'node', 'python']),
  script: z.string().min(1).max(1_048_576),
  cwd: z.string().default('.'),
  env: z.record(z.string(), z.string()).default({}),
  allowNetwork: z.boolean().default(true),
})

export interface ShellPackOptions {
  paths: PathView
  runProcess: ProcessRunner
  sandbox: Sandbox
  writableRoots: string[]
  /** Host paths no command may see, Buckle's own state above all. */
  hiddenPaths: string[]
  /** Host directories a mounted command may still read. */
  readOnlyPaths: string[]
  /** Set when there is no usable sandbox or shell was turned off, which withholds these tools. */
  unavailableReason: string | null
}

export function createShellPack(options: ShellPackOptions): Pack {
  const execute = async (input: {
    command: string
    args: string[]
    cwd: string
    env: Record<string, string>
    allowNetwork: boolean
    timeoutMs: number
    signal: AbortSignal
  }): Promise<JsonValue> => {
    const cwd = options.paths.resolve(input.cwd)
    const wrapped = options.sandbox.wrap({
      command: input.command,
      args: input.args,
      cwd,
      writableRoots: options.writableRoots,
      allowNetwork: input.allowNetwork,
      mount: options.paths.mount ? { root: options.paths.root, at: options.paths.mount } : null,
      hiddenPaths: options.hiddenPaths,
      readOnlyPaths: options.readOnlyPaths,
    })
    return toJson(await options.runProcess({
      command: wrapped.command,
      args: wrapped.args,
      cwd,
      timeoutMs: input.timeoutMs,
      environment: buildChildEnvironment({ parent: process.env, extra: input.env }),
      signal: input.signal,
    }), options.sandbox.mode)
  }

  return {
    id: PACK_ID,
    version: '1.0.0',
    unavailableReason: options.unavailableReason,
    skills: [loadPackSkill(PACK_ID)],
    tools: [
      defineTool(PACK_ID, {
        name: 'shell_exec',
        description: 'Run one program with an argument array. No shell interpretation, so quoting is never a hazard.',
        risk: 'execute',
        tags: ['shell', 'process'],
        input: execInput,
        effects: input => [
          { kind: 'exec', command: input.command, args: input.args },
          { kind: 'write_path', path: input.cwd },
        ],
        run: (input, context) => execute({ ...input, timeoutMs: context.timeoutMs, signal: context.signal }),
      }),
      defineTool(PACK_ID, {
        name: 'script_run',
        description: 'Run a Bash, Node, or Python script body in a child process.',
        risk: 'execute',
        tags: ['shell', 'script'],
        input: scriptInput,
        effects: input => {
          const runtime = RUNTIMES[input.runtime](input.script)
          return [
            { kind: 'exec', command: runtime.command, args: runtime.args },
            { kind: 'write_path', path: input.cwd },
          ]
        },
        run: (input, context) => execute({
          ...RUNTIMES[input.runtime](input.script),
          cwd: input.cwd,
          env: input.env,
          allowNetwork: input.allowNetwork,
          timeoutMs: context.timeoutMs,
          signal: context.signal,
        }),
      }),
    ],
  }
}

function toJson(result: ProcessResult, sandboxMode: string): JsonValue {
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.truncated,
    timedOut: result.timedOut,
    sandbox: sandboxMode,
  }
}
