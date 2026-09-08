import { relative, resolve } from 'node:path'
import { runIsolatedShell, type IsolatedShellOptions } from '../../services/isolated-shell.js'
import { collectShellHiddenPaths } from '../../services/shell-filesystem.js'
import { isInsideAny } from '../../domain/paths.js'
import { z } from 'zod'
import type { JsonValue } from '@5straps/protocol'
import { buildChildEnvironment } from '../../domain/environment.js'
import type { Pack } from '../../domain/pack.js'
import type { PathView } from '../../domain/path-view.js'
import { defineTool, ToolInputError, type ToolContext } from '../../domain/tool.js'
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
  allowNetwork: z.boolean().default(false),
})

const scriptInput = z.object({
  runtime: z.enum(['bash', 'node', 'python']),
  script: z.string().min(1).max(1_048_576),
  cwd: z.string().default('.'),
  env: z.record(z.string(), z.string()).default({}),
  allowNetwork: z.boolean().default(false),
})

export interface ShellPackOptions {
  paths: PathView
  runProcess: ProcessRunner
  sandbox: Sandbox
  writableRoots: string[]
  allowNetwork?: boolean
  isolation?: IsolatedShellOptions
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
    tool: string
    context: ToolContext
  }): Promise<JsonValue> => {
    const cwd = options.paths.resolve(input.cwd)
    if (!isInsideAny(options.writableRoots, cwd)) throw new ToolInputError('Shell working directory must be in the workspace or an owner-configured writable root', { code: 'PERMISSION_DENIED' })
    if (input.allowNetwork && !options.allowNetwork) throw new ToolInputError('Shell networking is disabled by the owner; use the web tools for scoped network access', { code: 'PERMISSION_DENIED' })
    const hidden = options.sandbox.mode === 'none' ? { directories: options.hiddenPaths, files: [] } : await collectShellHiddenPaths({
      roots: [options.paths.root, ...options.writableRoots, ...options.readOnlyPaths], protectedPaths: options.hiddenPaths, signal: input.signal,
    })
    const writableRoots = [cwd, ...options.paths.scratchRoots]
    const run = (copyRoot?: string) => {
      const mapped = (path: string) => copyRoot ? resolve(copyRoot, relative(options.paths.root, path)) : path
      const wrapped = options.sandbox.wrap({
        command: input.command,
        args: input.args,
        cwd: mapped(cwd),
        writableRoots: writableRoots.map(mapped),
        workspaceRoot: copyRoot ?? options.paths.root,
        allowNetwork: input.allowNetwork,
        commandIsPid1: Boolean(copyRoot),
        mount: copyRoot ? { root: copyRoot, at: options.paths.displayRoot } : options.paths.mount ? { root: options.paths.root, at: options.paths.mount } : null,
        hiddenPaths: copyRoot ? hidden.directories.filter(path => !isInsideAny([options.paths.root], path)) : hidden.directories,
        hiddenFiles: copyRoot ? hidden.files.filter(path => !isInsideAny([options.paths.root], path)) : hidden.files,
        readOnlyPaths: options.readOnlyPaths,
      })
      return options.runProcess({
        command: wrapped.command, args: wrapped.args, cwd: mapped(cwd), timeoutMs: input.timeoutMs,
        environment: buildChildEnvironment({ parent: process.env, extra: input.env }), signal: input.signal,
      })
    }
    if (!options.isolation) return toJson(await run(), options.sandbox.mode)
    if (options.sandbox.mode !== 'bubblewrap') throw new ToolInputError('Isolated shell execution requires bubblewrap', { code: 'PERMISSION_DENIED' })
    if (writableRoots.some(root => !isInsideAny([options.paths.root], root))) throw new ToolInputError('Isolated shell scratch roots must be inside the workspace', { code: 'PERMISSION_DENIED' })
    const result = await runIsolatedShell({
      isolation: options.isolation, sourceRoot: options.paths.root, writableRoots,
      excluded: [...hidden.directories, ...hidden.files],
      details: { sessionId: input.context.sessionId, stageId: input.context.stageId ?? input.context.requestId, tool: input.tool },
      execute: run,
    })
    return toJson(result, options.sandbox.mode)
  }

  return {
    id: PACK_ID,
    version: '1.0.0',
    unavailableReason: options.unavailableReason,
    skills: [loadPackSkill(PACK_ID)],
    tools: [
      defineTool(PACK_ID, {
        name: 'shell_exec',
        managesHistory: Boolean(options.isolation),
        description: 'Run one program with an argument array. No shell interpretation, so quoting is never a hazard.',
        risk: 'execute',
        tags: ['shell', 'process'],
        input: execInput,
        effects: input => [
          { kind: 'exec', command: input.command, args: input.args },
          { kind: 'write_path', path: input.cwd },
        ],
        run: (input, context) => execute({ ...input, tool: 'shell_exec', timeoutMs: context.timeoutMs, signal: context.signal, context }),
      }),
      defineTool(PACK_ID, {
        name: 'script_run',
        managesHistory: Boolean(options.isolation),
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
          tool: 'script_run',
          cwd: input.cwd,
          env: input.env,
          allowNetwork: input.allowNetwork,
          timeoutMs: context.timeoutMs,
          signal: context.signal,
          context,
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
