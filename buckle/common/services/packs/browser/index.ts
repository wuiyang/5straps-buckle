import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'pathe'
import { z } from 'zod'
import type { JsonValue } from '@5straps/protocol'
import { browserArguments, chromiumSwitch } from '../../../domain/browser-arguments.js'
import { hostEnvironment, type HostEnvironment } from '../../../domain/environment.js'
import { ownRoots, type Program, type ProgramRefusal, type ResolvedProgram } from '../../../domain/executable.js'
import type { Pack } from '../../../domain/pack.js'
import type { PathView } from '../../../domain/path-view.js'
import { defineTool, ToolExecutionError, ToolInputError, type FilledSecret, type FilledSecrets, type ToolContext } from '../../../domain/tool.js'
import type { ProcessResult, ProcessRunner } from '../../../types/ports/process-runner.js'
import { logger } from '../../../runtime/log.js'
import { loadPackSkill } from '../pack-skill.js'
import { browserAllowedDomains, type ApprovedList, type LoosenedEntry } from './allowed-domains.js'
import { argumentOrder, browserEffects, flagRefusal, navigationTargets, refusedFlag } from './effects.js'
import { prepareTransfer, sweepTransfers } from './file-transfer.js'
import { attachedChrome, containmentWarning, DEFAULT_IDLE_TIMEOUT_MS, FRESH_BROWSER, MODE_DESCRIPTIONS, modeFingerprint, profileSession, settingScrubber, type BrowserChoice, type BrowserMode } from './mode.js'
import { describeProcessFailure } from '../process-failure.js'
import { endpointClosed } from './endpoint-probe.js'
import { claimCaller, closeAll, closeEach, CLOSE_TIMEOUT_MS, closeWritten, endStranded, heldFor, releaseSession, retireSessions, settleClaims, takeSession, type CallScope, type Lifecycle } from './lifecycle.js'
import { holdInstance, mergeFilled, PROCESS_INSTANCE, releaseInstance, sessionsStore, upgradeSessions, writerOf } from './sessions.js'

const PACK_ID = 'browser'

const FRESH_COMMANDS = new Set(['open', 'snapshot', 'click', 'dblclick', 'fill', 'type', 'press', 'keydown', 'keyup', 'hover', 'focus', 'check', 'uncheck', 'select', 'scroll', 'scrollintoview', 'drag', 'upload', 'download', 'screenshot', 'pdf', 'get', 'is', 'wait', 'eval', 'back', 'forward', 'reload', 'tab', 'frame', 'dialog', 'console', 'errors', 'highlight', 'close', 'find', 'mouse', 'touch', 'set'])

/** The flags that pick the browser's session, its saved state, or its policy, which Buckle alone sets. */
const SESSION_FLAGS = ['--session', '--namespace', '--restore', '--restore-save', '--state', '--load', '--credential-provider', '--action-policy']

/** Mode-neutral: a profile or an attached browser is the owner's choice, never one an agent's call can make. */
const SESSION_REFUSAL = 'Buckle\'s browser cannot attach, restore, or override session identity'

/**
 * Fixed text, so the agent reads the same sentence whichever browser was reset. Only a fresh browser is passed
 * allowed domains, so only a fresh browser relaunches when they change.
 */
const RELAUNCH_NOTICE = 'The browser was relaunched because the allowed domains changed; open tabs and cookies were reset.'

/**
 * Fixed text after a failed command on a profile folder: each workspace and node names its own browser on the folder
 * (profileSession), and Chrome opens a folder in one browser at a time, so another's still open refuses this one's.
 */
const PROFILE_IN_USE = 'A profile folder opens in one browser at a time: where another workspace or Buckle node still has it open, that browser ends first, at its idle timeout or with the owner\'s buckle browser close in that workspace'

/** What a close answers where its caller has no browser recorded: it ran nothing, so agent-browser launched nothing to close. */
const NO_BROWSER_NOTICE = 'No browser was open for this session, so nothing was closed.'

/** What a close answers where a call still runs on the browser, which closes once the last call on it ends (Codex review L3). */
const CLOSES_AFTER_NOTICE = 'A call still runs on this browser, so it closes when that call ends.'

/** What a close answers where another close is on its way to the browser, which ends it (Codex recheck L3). */
const CLOSING_NOTICE = 'A close sent before this one is ending this browser.'

const commandInput = z.object({
  command: z.string().regex(/^[a-z][a-z0-9-]*$/).max(100),
  args: z.array(z.string().max(100_000)).max(200).default([]),
  session: z.string().min(1).max(200).optional(),
})

export interface BrowserPackOptions {
  cwd: string
  paths: PathView
  runProcess: ProcessRunner
  /** The command as configured, which an exec rule judges. */
  agentBrowserCommand: string
  /** Protected daemon mapping and configuration, never a browser profile. */
  sessionDirectory: string
  /** Launch a visible window instead of headless. A per-call --headed flag still wins. Never passed to an attached browser. */
  headed: boolean
  /** The browser the owner's settings choose (chooseBrowser), or why none is run; a fresh one when absent. */
  browser?: BrowserChoice
  /** BUCKLE_BROWSER_ARGS as the owner wrote it, passed as agent-browser's --args to a browser Buckle launches. */
  launchArgs?: string
  /** The configured command resolved once (resolveProgram): the real path every call spawns, or why none is run. */
  agentBrowser: ResolvedProgram
  /** The environment it runs with (hostEnvironment); the workspace's own roots alone when absent. */
  environment?: HostEnvironment
  /**
   * The workspace's approved list, when it has one, else nothing. Passed on every call as --allowed-domains, so
   * clicks, redirects and page requests stay on their hosts too. The pack is rebuilt when the list changes, and a
   * daemon keeps the list it was launched with, so a session last run under another list has its browser closed and a
   * new one named at its next call, before that call runs, which says so (RELAUNCH_NOTICE). The pack replaced ends its
   * own browsers once its calls end (retire), and never one under a name the new pack chose.
   */
  approvedLists: ApprovedList[]
  /** Buckle's protected roots: an upload of a hard-linked file on their device is refused. */
  protectedRoots?: readonly string[]
  /** The longest a call may run; a transfer directory twice as old is left from a stopped node. */
  maxTimeoutMs?: number
  /**
   * How long an idle daemon lives (browser.idleTimeoutMs, Q10): it closes a browser Buckle launched, and only disconnects
   * from an attached one. Five minutes when absent.
   */
  idleTimeoutMs?: number
  /**
   * The name of another workspace the profile folder or attached Chrome belongs to, read at each call (Q10: one
   * workspace at a time), or null where it is this workspace's; never asked where absent.
   */
  heldBy?: () => string | null
  /** Whether a service runs this node, read when a restart hint is logged, so it names buckle service restart (Phase 3, item 7). */
  serviceInstalled?: () => boolean
  /** The platform the node runs on; the host's unless a test imitates Windows. */
  platform?: NodeJS.Platform
  /**
   * Which Buckle runtime writes the sessions, beside the process's pid: a runtime passes its own, held from this pack's
   * start to its shutdown, so a session a runtime left is told from one a live runtime still uses. The process's own
   * where absent.
   */
  instance?: string
  /** The workspace's name, which a refusal's owner command names (buckle browser close --workspace); read at each refusal. */
  workspaceName?: () => string
}

/** The node's own default for the longest call, when the pack is built without one. */
const DEFAULT_MAX_TIMEOUT_MS = 300_000

/** Names the setting, never its value, which can be a path outside the workspace. */
export const BROWSER_UNAVAILABLE = 'BUCKLE_AGENT_BROWSER_COMMAND names a path that holds no program Buckle can run'
/** As BROWSER_UNAVAILABLE, for a command found where the agent writes. */
export const BROWSER_UNTRUSTED = 'BUCKLE_AGENT_BROWSER_COMMAND names a program inside the workspace or a scratch root, where an agent can write, so Buckle does not run it'
/** How the owner installs agent-browser where Buckle looks, outside any workspace (docs/browser-login.md). */
export const BROWSER_INSTALL = 'install it with npm i -g agent-browser, then run agent-browser install'
/** What runs without a shim: the native program agent-browser's package holds, or its script. */
const BROWSER_EXECUTABLE = 'the agent-browser .exe or script inside its package'

/**
 * Why the browser pack is withheld for want of its program, in text the agent may read in the manifest: where Buckle
 * looked, each place by its label, or the shim it found, by its file name, and never a path, as the configured value
 * and the places are the owner's (program detection brief, 2026-10-14). `buckle init` shows the owner the paths.
 */
export function browserUnavailable(command: string, program: ProgramRefusal): string {
  if (program.untrusted) return BROWSER_UNTRUSTED
  const { shim, searched } = program
  if (shim && shim.place === null) return `BUCKLE_AGENT_BROWSER_COMMAND names ${shim.why}; set it to ${BROWSER_EXECUTABLE}`
  if (shim) return `${command} was found ${shim.place} as ${shim.file}, ${shim.why}; set BUCKLE_AGENT_BROWSER_COMMAND to ${BROWSER_EXECUTABLE}`
  if (searched) return `${command} was not found ${searched}; ${BROWSER_INSTALL}`
  return BROWSER_UNAVAILABLE
}

export function createBrowserPack(options: BrowserPackOptions): Pack {
  // A node that stopped mid-call leaves its transfer copies behind; each pack start clears them (review L4 of the second re-review).
  const staleAfterMs = 2 * (options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS)
  sweepTransfers({ directory: options.sessionDirectory, staleAfterMs })
  const sessions = sessionsStore(options.sessionDirectory)
  const instance = options.instance ?? PROCESS_INSTANCE
  holdInstance(instance)
  const configFile = join(options.sessionDirectory, CONFIG_FILE)
  const allowedDomains = browserAllowedDomains(options.approvedLists)
  const choice = options.browser ?? { mode: FRESH_BROWSER }
  const mode: BrowserMode | null = 'mode' in choice ? choice.mode : null
  // agent-browser's output names the endpoint or the profile folder when it cannot reach or open them.
  const scrub = settingScrubber(mode ?? FRESH_BROWSER)
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const fingerprint = modeFingerprint(mode ?? FRESH_BROWSER, { launchArgs: options.launchArgs, headed: options.headed, idleTimeoutMs })
  // agent-browser refuses --allowed-domains with a profile or an attached browser, so only a fresh one is passed the list.
  const flag = mode?.kind === 'fresh' && 'value' in allowedDomains ? allowedDomains.value : null
  // Every caller of the workspace shares the one browser on a profile folder, its sessions store's own. Elsewhere each
  // caller, stage, and alias has its own, started under this pack's settings, so no process ever reaches a session
  // started in another mode.
  const namespace = resolve(options.sessionDirectory)
  const callScope = (running: BrowserMode, context: ToolContext, alias: string | undefined): CallScope => ({
    kind: running.kind,
    caller: { caller: context.sessionId, stage: context.stageId ?? 'default', alias: alias ?? 'default' },
    fingerprint,
    own: running.kind === 'profile' ? profileSession(running.directory, namespace) : null,
    chrome: running.kind === 'attached' ? attachedChrome(running.endpoint) : null,
    flag,
  })
  const lifecycle: Lifecycle = {
    store: sessions,
    me: writerOf(instance),
    idleTimeoutMs,
    longestCallMs: options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS,
    close: (session, signal) => closeSession(options, session, signal),
    ...(options.workspaceName ? { workspaceName: options.workspaceName } : {}),
    ...(mode?.kind === 'attached' ? { chromeClosed: async () => (await endpointClosed(mode.endpoint) ? attachedChrome(mode.endpoint) : null) } : {}),
  }
  // Slice F4, item 4: what a process that stopped without its close step left is ended at once, before any call here.
  const started = options.agentBrowser.path === null ? Promise.resolve() : endStranded(lifecycle).catch((error: unknown) => { logger.warn('The browser sessions a stopped Buckle process left could not be ended; the next start tries again', { error }) })
  const unavailableReason = options.agentBrowser.path !== null ? ('refusal' in choice ? choice.refusal : null) : browserUnavailable(options.agentBrowserCommand, options.agentBrowser)
  if (unavailableReason === null && mode) logContainmentOff(mode)
  if (unavailableReason === null) warnOldWindowsBrowser(options)
  // The browser daemons this pack started and has not closed, which the retire of a pack a settings change replaces
  // closes. The one browser on a profile folder is never among them: a successor on the same folder reuses it. Shutdown
  // closes every session this process wrote, whichever pack started it (closeWritten).
  const opened = new Set<string>()
  // Q10: a profile folder or an attached Chrome serves one workspace at a time; read at each use, so a change is seen at once.
  const assertHeld = (running: BrowserMode): void => {
    const holder = running.kind === 'fresh' ? null : options.heldBy?.() ?? null
    if (holder !== null) throw new ToolExecutionError(heldRefusal(running, holder), { code: 'BROWSER_COMMAND_FAILED' })
  }
  // What each call's session held as the call ended, by the call's own signal, which its late masking is handed too, for
  // that masking, which reads it after: a close the call ended its session with, as the last call on it, forgot the
  // session and its hold (Codex review L3).
  const ended = new WeakMap<AbortSignal, FilledSecret[]>()
  // The values a call's browser holds from secret references, as the browser packs record them in sessions.json, read
  // again at each browser call (runWithSecrets), so a process beside the one that filled, or one started after it
  // stopped, masks the page too; once what a stopped process left is ended, as its hold ends with it (Slice F4, item 5).
  const filled: FilledSecrets = {
    list: async ({ context, args }) => {
      await started
      if (mode === null) return []
      const state = sessions.read()
      upgradeSessions(state)
      const held = heldFor(lifecycle, state, callScope(mode, context, typeof args.session === 'string' ? args.session : undefined))
      const last = ended.get(context.signal)
      return last === undefined ? held : mergeFilled(held, last)
    },
  }
  const endedHold = (signal: AbortSignal, held: FilledSecret[]) => {
    if (held.length > 0) ended.set(signal, held)
  }
  return {
    id: PACK_ID,
    version: '1.0.0',
    skills: [loadPackSkill(PACK_ID)],
    filled,
    // No path: the manifest carrying it is read with the agent token, and the configured path is the owner's.
    unavailableReason,
    // Every session this process wrote ends with it, whichever pack started it (Slice F4, item 4).
    close: async () => {
      await started
      opened.clear()
      try { await closeWritten(lifecycle) } finally { releaseInstance(instance) }
    },
    retire: async () => {
      const names = [...opened]
      opened.clear()
      await retireSessions(lifecycle, names)
    },
    closeBrowsers: async () => {
      await started
      opened.clear()
      return closeAll(lifecycle)
    },
    tools: [
      defineTool(PACK_ID, {
        name: 'browser_command',
        // Only a profile folder is refused, and a withheld pack's tool is never offered, so its text is the profile one.
        description: MODE_DESCRIPTIONS[mode?.kind ?? 'profile'],
        risk: 'execute',
        tags: ['browser', 'agent-browser', 'network'],
        input: commandInput,
        effects: input => {
          // Before anything is judged, so the owner is never asked about a call that cannot run: not one the command refuses,
          // and not one another workspace's hold on the profile folder or the Chrome refuses.
          assertRunnable(input)
          if (mode !== null) assertHeld(mode)
          if ('refusal' in allowedDomains) throw new ToolInputError(allowedDomains.refusal, { code: 'PERMISSION_DENIED' })
          return [
            { kind: 'exec', command: options.agentBrowserCommand, args: [input.command, ...input.args], ...(isAbsolute(options.agentBrowserCommand) ? { shownAs: basename(options.agentBrowserCommand) } : {}) },
            ...browserEffects(input.command, input.args),
          ]
        },
        run: async (input, context): Promise<JsonValue> => {
          const running = browserMode(mode)
          assertRunnable(input)
          // Read again now: a change between the ask and the run is seen at once.
          assertHeld(running)
          const refused = refusedFlag(input.args)
          if (refused) throw new ToolInputError(flagRefusal(refused))
          await started
          const scope = callScope(running, context, input.session)
          if (input.command === 'close') return await closeCaller({ options, lifecycle, opened, scope, context, scrub })

          // Resolve file arguments against the authorized workspace, not the daemon state directory.
          const fileEffects = browserEffects(input.command, input.args)
          const filePaths = (kind: 'read_path' | 'write_path') => fileEffects.flatMap(effect => effect.kind === kind ? [effect.path] : [])
          const reads = filePaths('read_path')
          const writes = filePaths('write_path')
          if (['screenshot', 'pdf', 'download', 'upload'].includes(input.command) && reads.length + writes.length === 0) throw new ToolInputError('Browser file operations require an explicit path')
          mkdirSync(options.sessionDirectory, { recursive: true, mode: 0o700 })
          // Each file argument is judged where it lands and reaches agent-browser only through a private copy (review items 0 and 4 of the proof-of-possession fixes).
          const transfer = await prepareTransfer({ directory: options.sessionDirectory, paths: options.paths, reads, writes, context, protectedRoots: options.protectedRoots ?? [], staleAfterMs })
          try {
            const targets = navigationTargets(input.command, input.args)
            const passed = input.args.map((argument, index) => targets.get(index) ?? transfer.argument(argument) ?? realPath(argument, options.paths))
            const args = [input.command, ...argumentOrder(input.command, input.args).map(index => passed[index]!), '--json']
            // Each value the call fills is held by its session under the same lock, before the browser is handed it, so a
            // close in another process never ends a hold this call is about to need. The call's lease on the session keeps
            // every close off it until the call ends (Codex review L3).
            const { session, relaunchedFrom, sibling, lease } = await takeSession(lifecycle, { scope, fills: context.secretFills ?? [], timeoutMs: context.timeoutMs, signal: context.signal })
            let ran: ProcessResult
            try {
              if (sibling) logSiblingSettings(options.sessionDirectory, options.serviceInstalled?.() === true)
              // Tracked before it runs, for the same reason: a daemon a failed first call started is still ended by the
              // retire of the pack a change replaces, and by the node's shutdown.
              if (running.kind !== 'profile') opened.add(session)
              args.push('--config', configFile, '--session', session, ...modeArguments(running, { flag, headed: options.headed && !input.args.includes('--headed'), launchArgs: launchArguments(options.launchArgs, options.platform ?? process.platform), idleTimeoutMs }))
              if (flag !== null && 'loosened' in allowedDomains) logLoosened(allowedDomains.loosened)

              writeFileSync(configFile, '{}\n', { mode: 0o600 })
              const program = browserProgram(options)
              ran = await options.runProcess({
                command: program.path,
                argv0: program.argv0,
                args: [...program.args, ...args],
                cwd: options.sessionDirectory,
                timeoutMs: context.timeoutMs,
                environment: browserEnvironment(options),
                signal: context.signal,
                windowsHide: true,
              })
            } finally {
              await releaseSession(lifecycle, session, lease).then(held => endedHold(context.signal, held), (error: unknown) => { logger.warn('A browser call could not end its lease on its session; it lapses at the call\'s timeout', { error }) })
            }
            const failed = ran.exitCode !== 0
            const result = { ...ran, stdout: scrub(transfer.shown(ran.stdout), failed), stderr: scrub(transfer.shown(ran.stderr), failed) }
            if (result.exitCode !== 0) {
              throw new ToolExecutionError(`${describeProcessFailure('agent-browser', result)}${running.kind === 'profile' ? `. ${PROFILE_IN_USE}` : ''}`, { code: 'BROWSER_COMMAND_FAILED' })
            }
            await transfer.deliver()
            const relaunched = relaunchedFrom !== undefined
            if (relaunched) logger.warn('Browser relaunched because its allowed domains changed', { previous: relaunchedFrom ?? 'none', current: flag ?? 'none' })
            return { result: parseJsonOutput(result.stdout), stderr: result.stderr, truncated: result.truncated, ...(relaunched ? { notice: RELAUNCH_NOTICE } : {}) }
          } finally {
            transfer.close()
          }
        },
      }),
    ],
  }
}

/**
 * Refuses a command Buckle does not run, or a flag that would choose the session, its saved state, or its policy. A
 * close takes no arguments: `close --all` ends every agent-browser session on the machine, the owner's own among them,
 * and a launch flag such as --headed would start a browser only to close it.
 */
function assertRunnable(input: { command: string; args: string[] }): void {
  if (!FRESH_COMMANDS.has(input.command)) throw new ToolInputError(`${input.command} is not run: ${SESSION_REFUSAL}`)
  if (input.command === 'close' && input.args.length > 0) throw new ToolInputError('close takes no arguments: it ends this session\'s browser alone')
  const identity = input.args.map(arg => arg.split('=')[0]!.toLowerCase()).find(name => SESSION_FLAGS.includes(name))
  if (identity) throw new ToolInputError(`${identity} is not allowed: ${SESSION_REFUSAL}`)
}

/**
 * An agent's close: its caller's recorded browsers alone, each with a bare close (closeArguments) under the call's own
 * timeout, so agent-browser never launches a browser to close one; where none is recorded nothing of the caller's runs.
 * A live sibling's session under other settings is that process's to close, and one another close is on its way to is
 * that close's. Every stranded session ends beside them, as before any call. One whose close fails stays marked closing,
 * for the next start.
 */
async function closeCaller(input: { options: BrowserPackOptions; lifecycle: Lifecycle; opened: Set<string>; scope: CallScope; context: ToolContext; scrub: (text: string, failed: boolean) => string }): Promise<JsonValue> {
  const { options } = input
  const { own, waiting, closing, stranded, closer } = await claimCaller(input.lifecycle, input.scope, input.context.timeoutMs)
  const ending = closeEach(input.lifecycle, stranded)
  if (own.length === 0) {
    await settleClaims(input.lifecycle, await ending, closer)
    return { result: { success: true, data: { closed: false } }, stderr: '', truncated: false, notice: waiting > 0 ? CLOSES_AFTER_NOTICE : closing ? CLOSING_NOTICE : NO_BROWSER_NOTICE }
  }
  const program = browserProgram(options)
  const results = await Promise.all(own.map(async (session) => {
    const ran = await options.runProcess({ command: program.path, argv0: program.argv0, args: [...program.args, ...closeArguments(emptyConfig(options), session)], cwd: options.sessionDirectory, timeoutMs: input.context.timeoutMs, environment: browserEnvironment(options), signal: input.context.signal, windowsHide: true })
      .catch((error: unknown) => ({ exitCode: null, signal: null, stdout: '', stderr: error instanceof Error ? error.message : String(error), truncated: false, timedOut: false }))
    const failed = ran.exitCode !== 0
    return { session, failed, result: { ...ran, stdout: input.scrub(ran.stdout, failed), stderr: input.scrub(ran.stderr, failed) } }
  }))
  for (const { session, failed } of results) if (!failed) input.opened.delete(session)
  await settleClaims(input.lifecycle, new Map([...await ending, ...results.map(({ session, failed }) => [session, !failed] as const)]), closer)
  const failure = results.find(item => item.failed)
  if (failure) throw new ToolExecutionError(describeProcessFailure('agent-browser', failure.result), { code: 'BROWSER_COMMAND_FAILED' })
  const { result } = results[0]!
  return { result: parseJsonOutput(result.stdout), stderr: result.stderr, truncated: result.truncated }
}

/** Buckle's empty agent-browser configuration, so the owner's own config.json is never read; each command names it. */
const CONFIG_FILE = 'fresh-config.json'

/** The empty configuration's path, written where it is missing, as a close may come before any command of this process. */
function emptyConfig(options: BrowserPackOptions): string {
  const file = join(options.sessionDirectory, CONFIG_FILE)
  mkdirSync(options.sessionDirectory, { recursive: true, mode: 0o700 })
  writeFileSync(file, '{}\n', { mode: 0o600 })
  return file
}

/**
 * A bare close: the session and Buckle's empty configuration alone. agent-browser sends `launch` before a command that
 * carries --allowed-domains, --headed, or --args, which starts a browser where its daemon idled out, only to close it.
 */
function closeArguments(configFile: string, session: string): string[] {
  return ['close', '--json', '--config', configFile, '--session', session]
}

/** The mode a call runs in; a pack whose profile folder was refused is withheld, so no call reaches here without one. */
function browserMode(mode: BrowserMode | null): BrowserMode {
  if (mode === null) throw new ToolExecutionError('BUCKLE_BROWSER_PROFILE names a folder Buckle does not load', { code: 'BROWSER_COMMAND_FAILED' })
  return mode
}

/**
 * The flags each mode adds after the session. A fresh browser takes the allowed domains; a profile folder takes
 * --profile instead, as agent-browser refuses the two together; both take --args (launchArguments) and --headed. An
 * attached browser takes --cdp alone: it keeps the profile, arguments, and window its owner started it with, and
 * agent-browser's close and idle shutdown only disconnect from it.
 */
function modeArguments(mode: BrowserMode, input: { flag: string | null; headed: boolean; launchArgs: string; idleTimeoutMs: number }): string[] {
  const args = ['--idle-timeout', String(input.idleTimeoutMs)]
  if (mode.kind === 'attached') return [...args, '--cdp', mode.endpoint]
  if (mode.kind === 'profile') args.push('--profile', mode.directory)
  if (input.flag !== null) args.push('--allowed-domains', input.flag)
  args.push('--args', input.launchArgs)
  if (input.headed) args.push('--headed')
  return args
}

/**
 * Chrome opens a New Tab window of its own at start, beside the page agent-browser makes, which agent-browser never
 * tracks, so it dangles until the browser closes (agent-browser #1544); this switch keeps it shut.
 */
const NO_STARTUP_WINDOW = '--no-startup-window'

/**
 * The --args a browser Buckle launches takes: the owner's arguments (BUCKLE_BROWSER_ARGS or browser.args), then
 * --no-startup-window, so one launch shows one window; the owner's value as written where it holds that switch already.
 */
export function launchArguments(owner: string | undefined, platform: NodeJS.Platform): string {
  if (owner !== undefined && browserArguments(owner).some(argument => chromiumSwitch(argument, platform)?.name === NO_STARTUP_WINDOW.slice(2))) return owner
  const written = owner?.replace(/[,\s]+$/, '') ?? ''
  return written ? `${written},${NO_STARTUP_WINDOW}` : NO_STARTUP_WINDOW
}

/** The first agent-browser that keeps a headless browser off the Windows desktop (agent-browser #1498). */
const WINDOWS_MINIMUM = [0, 37, 1] as const
const VERSION_TIMEOUT_MS = 10_000
const checkedVersions = new Set<string>()

/**
 * At pack start on Windows, once per process for each program: agent-browser before 0.37.1 shows a headless browser's
 * windows on the desktop, and leaves the old browser open when a daemon that ended is started again, so the owner's
 * log names its version and the upgrade. Asked of the program itself, which answers `agent-browser <version>`.
 */
function warnOldWindowsBrowser(options: BrowserPackOptions): void {
  const program = options.agentBrowser
  if ((options.platform ?? process.platform) !== 'win32' || program.path === null || checkedVersions.has(program.path)) return
  checkedVersions.add(program.path)
  void (async () => {
    mkdirSync(options.sessionDirectory, { recursive: true, mode: 0o700 })
    const ran = await options.runProcess({ command: program.path, argv0: program.argv0, args: [...program.args, '--version'], cwd: options.sessionDirectory, timeoutMs: VERSION_TIMEOUT_MS, environment: browserEnvironment(options), windowsHide: true })
    const found = /(\d+)\.(\d+)\.(\d+)/.exec(ran.stdout)
    if (!found) return
    const parts = found.slice(1, 4).map(Number)
    const older = parts.findIndex((part, index) => part !== WINDOWS_MINIMUM[index]!)
    if (older === -1 || parts[older]! > WINDOWS_MINIMUM[older]!) return
    logger.warn(`agent-browser ${found[0]} is older than ${WINDOWS_MINIMUM.join('.')}, which on Windows shows a headless browser's windows on the desktop and can leave a browser open when its daemon ends; upgrade it with npm i -g agent-browser@latest`, { version: found[0] })
  })().catch(() => {})
}

/** Why a call is refused while another workspace holds the profile folder or the attached Chrome: names that workspace, never the setting's value. */
function heldRefusal(mode: BrowserMode, holder: string): string {
  const what = mode.kind === 'attached' ? 'The owner\'s Chrome this browser attaches to' : 'The profile folder this browser keeps its logins in'
  return `${what} belongs to workspace ${holder}, and serves one workspace at a time; the owner chooses which with buckle workspace set browser.profile or browser.cdp`
}

/** The agent-browser spawned; a pack without one is withheld, so no call reaches here. */
function browserProgram(options: BrowserPackOptions): Program {
  if (options.agentBrowser.path === null) throw new ToolExecutionError(BROWSER_UNAVAILABLE, { code: 'BROWSER_COMMAND_FAILED' })
  return options.agentBrowser
}

/** agent-browser is a node script, so its PATH is the host program one, where no agent put a `node` (hostEnvironment). */
function browserEnvironment(options: BrowserPackOptions): NodeJS.ProcessEnv {
  return (options.environment ?? hostEnvironment(() => ownRoots(options.paths)))()
}


/**
 * Sends a bare close to one session's daemon, as the close command does: it closes a browser agent-browser launched and
 * only disconnects from an attached one. Whether it closed; one that did not stays marked closing, for the next start.
 */
async function closeSession(options: BrowserPackOptions, session: string, signal: AbortSignal): Promise<boolean> {
  if (options.agentBrowser.path === null) return false
  const program = browserProgram(options)
  const result = await options.runProcess({
    command: program.path,
    argv0: program.argv0,
    args: [...program.args, ...closeArguments(emptyConfig(options), session)],
    cwd: options.sessionDirectory,
    timeoutMs: CLOSE_TIMEOUT_MS,
    environment: browserEnvironment(options),
    signal,
    windowsHide: true,
  }).catch(() => ({ exitCode: null }))
  return result.exitCode === 0
}

const loggedSibling = new Set<string>()

/** Once per process for each workspace: fixed text naming the settings, never their values. */
function logSiblingSettings(sessionDirectory: string, serviceInstalled: boolean): void {
  if (loggedSibling.has(sessionDirectory)) return
  loggedSibling.add(sessionDirectory)
  logger.warn(`Another Buckle process on this node runs the browser under other BUCKLE_BROWSER_CDP, BUCKLE_BROWSER_PROFILE, BUCKLE_BROWSER_ARGS, or BUCKLE_BROWSER_HEADED settings; its browser session is not closed: a profile folder's is shared, and any other runs beside this process's own. Restart every Buckle process on the node after changing them${serviceInstalled ? ': buckle service restart for the service, and each buckle mcp through its client' : ''}`)
}

const loggedLoosened = new Set<string>()
const loggedContainmentOff = new Set<string>()

/** At pack start, once per process for each setting: which setting turned containment off, never its value. */
function logContainmentOff(mode: BrowserMode): void {
  const warning = containmentWarning(mode)
  if (!warning || loggedContainmentOff.has(warning.setting)) return
  loggedContainmentOff.add(warning.setting)
  logger.warn(warning.message, { setting: warning.setting })
}

/** At the first browser call rather than at pack build, which every CLI command does; once per process for each set. */
function logLoosened(loosened: LoosenedEntry[]): void {
  const described = loosened.map(item => `${item.entry} (${item.list} list) as ${item.host}`).join(', ')
  if (!described || loggedLoosened.has(described)) return
  loggedLoosened.add(described)
  logger.info('The browser is held to these approved hosts on any port and path; Buckle still judges the page a command names by port and path', { loosened: described })
}

function realPath(argument: string, paths: PathView): string {
  if (argument.startsWith('-')) return argument
  return paths.namesVirtual(argument) ? paths.resolve(argument) : argument
}

/** Most agent-browser commands honour --json; a few (screenshot paths) print plain text. */
function parseJsonOutput(stdout: string): JsonValue {
  try {
    return JSON.parse(stdout) as JsonValue
  } catch {
    return stdout
  }
}
