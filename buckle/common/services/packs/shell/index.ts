import { existsSync, realpathSync, statSync } from 'node:fs'
import { overlapReason, refuseChangedFolder, scratchRootOverFolder, validateSandboxMounts } from '../../../domain/sandbox-mounts.js'
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
import { referenceHint } from '../../../domain/secret-reference-hint.js'
import { defineTool, ToolInputError, type ToolContext } from '../../../domain/tool.js'
import type { ProcessRunner, ProcessResult } from '../../../types/ports/process-runner.js'
import type { Sandbox, SandboxBind } from '../../../types/ports/sandbox.js'
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
/** Why a variable name is refused: a child's environment entry is `name=value`, so a name holding `=` sets another variable. */
const ENV_NAME_REFUSAL = 'An env name must be non-empty and hold no "=" and no NUL character'
/**
 * Variables the call sets for its command. Bounded, so no request spends the node's event loop on them: one with
 * 20,000 names held it for seconds while the environment was merged (re-check of 2026-10-14). A name holding `=` is
 * refused: the child would read `PATH=/w/bin=x` as PATH (fix brief 2, H4).
 */
const envInput = z.record(z.string().max(MAX_ENV_NAME), z.string())
  .refine(env => Object.keys(env).length <= MAX_ENV_ENTRIES, `env holds at most ${MAX_ENV_ENTRIES} variables`)
  .refine(env => Object.keys(env).every(name => /^[^=\u0000]+$/.test(name)), ENV_NAME_REFUSAL)
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
  /** The workspace's mounts, each bound at its target (sandboxBinds). */
  mounts?: SandboxBind[]
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
  /** The workspace's own variables (Q13), which every command sees under the call's `env`. None when absent. */
  commandEnvironment?: Readonly<Record<string, string>>
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
    // The folder is bound, or copied, at its stored path, which must still land on itself (fix brief 6, item 2): checked
    // here, and again just before the copy and before each wrap, so nothing is bound or copied where a link lands.
    const folderInPlace = () => refuseChangedFolder(options.paths.root, options.paths.mount)
    folderInPlace()
    const mounts = validateSandboxMounts(options.mounts ?? [], { protectedRoots: options.hiddenPaths, workspaceRoots: options.writableRoots, workspaceTarget: options.paths.displayRoot })
    if (mounts.length && options.sandbox.mode !== 'bubblewrap') throw new ToolInputError('The workspace\'s mounts need bubblewrap', { code: 'PERMISSION_DENIED' })
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
    // A root not made yet, or gone since the node started, is bound nowhere and holds nothing to hide, so it is not scanned.
    const hidden = options.sandbox.mode === 'none' ? { directories: options.hiddenPaths, files: [] } : await collectShellHiddenPaths({
      roots: [options.paths.root, ...options.writableRoots, ...options.readOnlyPaths].filter(root => existsSync(root)), protectedPaths: options.hiddenPaths, signal: input.signal,
    })
    if (options.sandbox.mode === 'none' && options.filesystemPolicy?.policy.filesystem?.rules.length) throw new ToolInputError('Filesystem policy requires an operating-system sandbox', { code: 'PERMISSION_DENIED' })
    const restrictions = options.filesystemPolicy
      ? await projectFilesystemSandbox({ root: options.paths.root, ...options.filesystemPolicy, signal: input.signal })
      : { hiddenPaths: [], hiddenFiles: [], readOnlyWorkspacePaths: [] }
    hidden.directories.push(...restrictions.hiddenPaths)
    hidden.files.push(...restrictions.hiddenFiles)
    // A scratch root not made yet, or gone since the node started, is bound nowhere: bwrap would refuse a bind of it.
    const scratchRoots = options.paths.scratchRoots.filter(root => existsSync(root))
    const writableRoots = [cwd, ...scratchRoots]
    // Isolation copies the workspace's folder alone (Q6): a scratch root outside it, and each mount the owner shares
    // writable, is bound read-only for the call, and its result names them.
    const isolated = Boolean(options.isolation)
    // Where the folder shows at a mount, a scratch root holding it would show it a second time, bound writable at its
    // own path, past the masks and the owner's rules laid where the folder shows (fix brief 6, item 3): refused, as the
    // isolated shell refuses it below. Without a mount there is one view, and nothing to refuse.
    const holding = !isolated && options.sandbox.mode === 'bubblewrap' ? scratchRootOverFolder(options.paths) : null
    if (holding !== null) throw new ToolInputError(overlapReason(holding), { code: 'PERMISSION_DENIED' })
    const outsideScratch = isolated ? scratchRoots.filter(root => !isInsideAny([options.paths.root], root)) : []
    const callWritable = writableRoots.filter(root => !outsideScratch.includes(root))
    // Bound as mounts are, so each is checked as one is: a root that moved, or that holds or sits inside Buckle's
    // state, is refused; one not made yet holds nothing to show. Hidden state inside one is masked where it shows.
    const scratchMounts = validateSandboxMounts(outsideScratch.filter(root => existsSync(root)).map(root => ({ source: root, target: root, readOnly: true })), { protectedRoots: options.hiddenPaths, workspaceRoots: [options.paths.root], workspaceTarget: options.paths.displayRoot })
    const callMounts = isolated ? [...mounts.map(mount => ({ ...mount, readOnly: true })), ...scratchMounts] : mounts
    const heldReadOnly = isolated ? [...mounts.filter(mount => !mount.readOnly).map(mount => mount.target), ...scratchMounts.map(mount => mount.target)] : []
    const run = (copyRoot?: string) => {
      const mapped = (path: string) => copyRoot ? resolve(copyRoot, relative(options.paths.root, path)) : path
      if (!copyRoot) folderInPlace()
      const wrapped = options.sandbox.wrap({
        command,
        args: [...program?.args ?? [], ...input.args],
        cwd: mapped(cwd),
        writableRoots: callWritable.map(mapped),
        workspaceRoot: copyRoot ?? options.paths.root,
        allowNetwork: input.allowNetwork,
        commandIsPid1: Boolean(copyRoot),
        mount: copyRoot ? { root: copyRoot, at: options.paths.displayRoot } : options.paths.mount ? { root: options.paths.root, at: options.paths.mount } : null,
        hiddenPaths: copyRoot ? hidden.directories.filter(path => !isInsideAny([options.paths.root], path)) : hidden.directories,
        hiddenFiles: copyRoot ? hidden.files.filter(path => !isInsideAny([options.paths.root], path)) : hidden.files,
        readOnlyPaths: options.readOnlyPaths,
        mounts: callMounts,
        overlays: sensitiveFiles.map(source => ({ source, target: options.paths.toVirtual(source), readOnly: true })),
        readOnlyWorkspacePaths: restrictions.readOnlyWorkspacePaths.map(mapped),
      })
      return options.runProcess({
        command: wrapped.command, argv0: program?.argv0, args: wrapped.args, cwd: mapped(cwd), timeoutMs: input.timeoutMs,
        // Buckle's own PATH, user, shell, and TMPDIR for the sandbox (Q11), then the workspace's variables, then the call's.
        environment: buildChildEnvironment({ parent: process.env, extra: { ...options.sandbox.environment?.(options.readOnlyPaths), ...options.commandEnvironment, ...input.env } }), signal: input.signal,
      })
    }
    if (!options.isolation) return toJson(await run(), options.sandbox.mode)
    if (options.sandbox.mode !== 'bubblewrap') throw new ToolInputError('Isolated shell execution requires bubblewrap', { code: 'PERMISSION_DENIED' })
    folderInPlace()
    const result = await runIsolatedShell({
      isolation: options.isolation, sourceRoot: options.paths.root, writableRoots: callWritable,
      excluded: [...hidden.directories, ...hidden.files, ...sensitiveFiles],
      readOnlyOverlayPaths: [...sensitiveFiles, ...hidden.directories.filter(directory => isInsideAny([options.paths.root], directory) && sensitiveFiles.some(path => isInsideAny([directory], path)))],
      readOnlyPaths: restrictions.readOnlyWorkspacePaths,
      // The invoker's history stage, which a script's call files under its parent request, as its other writes are
      // (recheck of the final review of 0.1.4, finding shell index.ts:151).
      details: { sessionId: input.context.sessionId, stageId: input.context.historyStage ?? input.context.stageId ?? input.context.requestId, tool: input.tool },
      ...(input.context.beginRun ? { beforeRun: input.context.beginRun } : {}),
      ...(input.context.untimed ? { untimed: input.context.untimed } : {}),
      signal: input.signal,
      execute: run,
    })
    return toJson(result, options.sandbox.mode, heldReadOnly)
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
        description: `Run one program with an argument array. Declare sensitiveFiles before execution to request sensitive file access; undeclared credentials stay hidden. ${referenceHint('shell_exec')}`,
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
            // The node runtime is Buckle's own binary, a host path no stage of the decision AI is shown.
            { kind: 'exec', command: runtime.command, args: runtime.args, ...(input.runtime === 'node' ? { shownAs: 'node' } : {}) },
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

/** A shell's result; `heldReadOnly` names, as the agent names them, the writable mounts isolation bound read-only for it. */
function toJson(result: ProcessResult, sandboxMode: string, heldReadOnly: readonly string[] = []): JsonValue {
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.truncated,
    timedOut: result.timedOut,
    sandbox: sandboxMode,
    ...(heldReadOnly.length > 0 ? { readOnlyMounts: [...heldReadOnly], note: `Shell isolation copies the workspace's folder alone, so these writable mounts were read-only to this command: ${heldReadOnly.join(', ')}. Write to them with the file tools, which ask as the workspace's own writes do.` } : {}),
  }
}
