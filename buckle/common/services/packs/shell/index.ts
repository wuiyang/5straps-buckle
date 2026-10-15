import { realpathSync, statSync } from 'node:fs'
import { validateSandboxMounts, type SandboxMount } from '../../../domain/sandbox-mounts.js'
import { projectFilesystemSandbox } from '../../../domain/filesystem-policy.js'
import type { WorkspacePolicy } from '@5straps/protocol'
import { relative, resolve } from 'pathe'
import { runIsolatedShell, type IsolatedShellOptions } from '../../shell/isolated-shell.js'
import { collectShellHiddenPaths } from '../../shell/shell-filesystem.js'
import { isInsideAny, nativePath } from '../../../domain/paths.js'
import { z } from 'zod'
import type { JsonValue } from '@5straps/protocol'
import { buildChildEnvironment } from '../../../domain/environment.js'
import { ownRoots, rootsOf, runnableCommand, type ProgramSearch, type UntrustedRoots } from '../../../domain/executable.js'
import type { Pack } from '../../../domain/pack.js'
import type { PathView } from '../../../domain/path-view.js'
import { defineTool, ToolInputError, type ToolContext } from '../../../domain/tool.js'
import type { ProcessRunner, ProcessResult } from '../../../types/ports/process-runner.js'
import type { Sandbox } from '../../../types/ports/sandbox.js'
import { loadPackSkill } from '../pack-skill.js'

const PACK_ID = 'shell'

const RUNTIMES = {
  bash: (script: string) => ({ command: 'bash', args: ['-c', script] }),
  node: (script: string) => ({ command: process.execPath, args: ['--input-type=module', '--eval', script] }),
  python: (script: string) => ({ command: 'python3', args: ['-c', script] }),
}

const sensitiveFilesInput = z.array(z.string().min(1)).max(32).default([]).describe('Exact workspace files needed by this command. Sensitive files require WARNING approval, allow once only; approved files are mounted read-only.')

/** How many variables a call may set, and how long a name may be: enough for any command, and too few to hold the node. */
const MAX_ENV_ENTRIES = 256
const MAX_ENV_NAME = 256
/**
 * Variables the call sets for its command. Bounded, so no request spends the node's event loop on them: one with
 * 20,000 names held it for seconds while the environment was merged (re-check of 2026-10-14).
 */
const envInput = z.record(z.string().max(MAX_ENV_NAME), z.string())
  .refine(env => Object.keys(env).length <= MAX_ENV_ENTRIES, `env holds at most ${MAX_ENV_ENTRIES} variables`)
  .default({})

const execInput = z.object({
  command: z.string().min(1).max(1_000),
  args: z.array(z.string().max(100_000)).max(1_000).default([]),
  cwd: z.string().default('.'),
  env: envInput,
  allowNetwork: z.boolean().default(false),
  sensitiveFiles: sensitiveFilesInput,
})

const scriptInput = z.object({
  runtime: z.enum(['bash', 'node', 'python']),
  script: z.string().min(1).max(1_048_576),
  cwd: z.string().default('.'),
  env: envInput,
  allowNetwork: z.boolean().default(false),
  sensitiveFiles: sensitiveFilesInput,
})

export interface ShellPackOptions {
  mounts?: SandboxMount[]
  filesystemPolicy?: { policy: WorkspacePolicy }
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
  /** How an unsandboxed command word is looked up (runnableCommand): the host's PATH unless a test imitates another platform. */
  programSearch?: ProgramSearch
  /** Where no program an unsandboxed command word names may come from, beside the writable roots: every root the node knows. */
  untrusted?: () => UntrustedRoots
}

export function createShellPack(options: ShellPackOptions): Pack {
  const untrustedBeside = (writableRoots: readonly string[]): UntrustedRoots => {
    const untrusted = options.untrusted?.() ?? ownRoots(options.paths)
    return { ...untrusted, untrustedRoots: [...untrusted.untrustedRoots, ...rootsOf('scratch root', writableRoots)] }
  }
  const execute = async (input: {
    command: string
    args: string[]
    cwd: string
    env: Record<string, string>
    allowNetwork: boolean
    sensitiveFiles: string[]
    timeoutMs: number
    signal: AbortSignal
    tool: string
    context: ToolContext
  }): Promise<JsonValue> => {
    const mounts = validateSandboxMounts(options.mounts ?? [], { protectedRoots: options.hiddenPaths, workspaceRoots: options.writableRoots, workspaceTarget: options.paths.displayRoot })
    if (mounts.length && options.sandbox.mode !== 'bubblewrap') throw new ToolInputError('Explicit mounts require bubblewrap', { code: 'PERMISSION_DENIED' })
    const sensitiveFiles = [...new Set(input.sensitiveFiles)].map(path => options.paths.resolve(path))
    if (sensitiveFiles.length && (options.sandbox.mode !== 'bubblewrap' || !options.isolation)) throw new ToolInputError('Sensitive file requests require isolated bubblewrap execution', { code: 'PERMISSION_DENIED' })
    for (const path of sensitiveFiles) {
      if (!isInsideAny([options.paths.root], path) || nativePath(realpathSync(path)) !== path || !statSync(path).isFile()) throw new ToolInputError('Sensitive file requests must name exact regular workspace files without symlink aliases')
      if (!await input.context.authorizeRead?.(path)) throw new ToolInputError('The requested file is not approved for this call', { code: 'PERMISSION_DENIED' })
    }
    const cwd = options.paths.resolve(input.cwd)
    if (!isInsideAny(options.writableRoots, cwd)) throw new ToolInputError('Shell working directory must be in the workspace or an owner-configured writable root', { code: 'PERMISSION_DENIED' })
    if (input.allowNetwork && !options.allowNetwork) throw new ToolInputError('Shell networking is disabled by the owner; use the web tools for scoped network access', { code: 'PERMISSION_DENIED' })
    // Unsandboxed, the command word is spawned as the system finds it, which on Windows is the working directory first.
    const program = options.sandbox.mode === 'none' ? runnableCommand(input.command, { ...untrustedBeside(options.writableRoots), ...options.programSearch }) : null
    const command = program?.path ?? input.command
    const hidden = options.sandbox.mode === 'none' ? { directories: options.hiddenPaths, files: [] } : await collectShellHiddenPaths({
      roots: [options.paths.root, ...options.writableRoots, ...options.readOnlyPaths], protectedPaths: options.hiddenPaths, signal: input.signal,
    })
    if (options.sandbox.mode === 'none' && options.filesystemPolicy?.policy.filesystem?.rules.length) throw new ToolInputError('Filesystem policy requires an operating-system sandbox', { code: 'PERMISSION_DENIED' })
    const restrictions = options.filesystemPolicy
      ? await projectFilesystemSandbox({ root: options.paths.root, ...options.filesystemPolicy, signal: input.signal })
      : { hiddenPaths: [], hiddenFiles: [], readOnlyWorkspacePaths: [] }
    hidden.directories.push(...restrictions.hiddenPaths)
    hidden.files.push(...restrictions.hiddenFiles)
    const writableRoots = [cwd, ...options.paths.scratchRoots]
    const run = (copyRoot?: string) => {
      const mapped = (path: string) => copyRoot ? resolve(copyRoot, relative(options.paths.root, path)) : path
      const wrapped = options.sandbox.wrap({
        command,
        args: [...program?.args ?? [], ...input.args],
        cwd: mapped(cwd),
        writableRoots: writableRoots.map(mapped),
        workspaceRoot: copyRoot ?? options.paths.root,
        allowNetwork: input.allowNetwork,
        commandIsPid1: Boolean(copyRoot),
        mount: copyRoot ? { root: copyRoot, at: options.paths.displayRoot } : options.paths.mount ? { root: options.paths.root, at: options.paths.mount } : null,
        hiddenPaths: copyRoot ? hidden.directories.filter(path => !isInsideAny([options.paths.root], path)) : hidden.directories,
        hiddenFiles: copyRoot ? hidden.files.filter(path => !isInsideAny([options.paths.root], path)) : hidden.files,
        readOnlyPaths: options.readOnlyPaths,
        mounts: [...mounts, ...sensitiveFiles.map(source => ({ source, target: options.paths.toVirtual(source), readOnly: true as const }))],
        readOnlyWorkspacePaths: restrictions.readOnlyWorkspacePaths.map(mapped),
      })
      return options.runProcess({
        command: wrapped.command, argv0: program?.argv0, args: wrapped.args, cwd: mapped(cwd), timeoutMs: input.timeoutMs,
        environment: buildChildEnvironment({ parent: process.env, extra: input.env }), signal: input.signal,
      })
    }
    if (!options.isolation) return toJson(await run(), options.sandbox.mode)
    if (options.sandbox.mode !== 'bubblewrap') throw new ToolInputError('Isolated shell execution requires bubblewrap', { code: 'PERMISSION_DENIED' })
    if (writableRoots.some(root => !isInsideAny([options.paths.root], root))) throw new ToolInputError('Isolated shell scratch roots must be inside the workspace', { code: 'PERMISSION_DENIED' })
    const result = await runIsolatedShell({
      isolation: options.isolation, sourceRoot: options.paths.root, writableRoots,
      excluded: [...hidden.directories, ...hidden.files, ...sensitiveFiles],
      readOnlyOverlayPaths: [...sensitiveFiles, ...hidden.directories.filter(directory => isInsideAny([options.paths.root], directory) && sensitiveFiles.some(path => isInsideAny([directory], path)))],
      readOnlyPaths: restrictions.readOnlyWorkspacePaths,
      // The invoker's history stage, which a script's call files under its parent request, as its other writes are
      // (recheck of the final review of 0.1.4, finding shell index.ts:151).
      details: { sessionId: input.context.sessionId, stageId: input.context.historyStage ?? input.context.stageId ?? input.context.requestId, tool: input.tool },
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
        description: 'Run one program with an argument array. Declare sensitiveFiles before execution to request sensitive file access; undeclared credentials stay hidden.',
        risk: 'execute',
        tags: ['shell', 'process'],
        input: execInput,
        effects: input => [
          ...input.sensitiveFiles.map(path => ({ kind: 'read_path' as const, path })),
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
            ...input.sensitiveFiles.map(path => ({ kind: 'read_path' as const, path })),
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
          sensitiveFiles: input.sensitiveFiles,
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
