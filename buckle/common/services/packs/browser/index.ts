import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'pathe'
import { z } from 'zod'
import { createJsonFileStore, type JsonFileStore } from '../../../adapters/json-file-store.js'
import type { JsonValue } from '@5straps/protocol'
import { hostEnvironment, type HostEnvironment } from '../../../domain/environment.js'
import { ownRoots, type Program, type ProgramRefusal, type ResolvedProgram } from '../../../domain/executable.js'
import type { Pack } from '../../../domain/pack.js'
import type { PathView } from '../../../domain/path-view.js'
import { defineTool, ToolExecutionError, ToolInputError, type FilledSecret } from '../../../domain/tool.js'
import type { ProcessRunner } from '../../../types/ports/process-runner.js'
import { logger } from '../../../runtime/log.js'
import { loadPackSkill } from '../pack-skill.js'
import { browserAllowedDomains, type ApprovedList, type LoosenedEntry } from './allowed-domains.js'
import { argumentOrder, browserEffects, flagRefusal, navigationTargets, refusedFlag } from './effects.js'
import { prepareTransfer, sweepTransfers } from './file-transfer.js'
import { containmentWarning, DEFAULT_IDLE_TIMEOUT_MS, FRESH_BROWSER, MODE_DESCRIPTIONS, modeFingerprint, profileSession, settingScrubber, type BrowserChoice, type BrowserMode } from './mode.js'
import { describeProcessFailure } from '../process-failure.js'
import type { FilledSecrets } from '../../secrets/call-secrets.js'

const PACK_ID = 'browser'

const FRESH_COMMANDS = new Set(['open', 'snapshot', 'click', 'dblclick', 'fill', 'type', 'press', 'keydown', 'keyup', 'hover', 'focus', 'check', 'uncheck', 'select', 'scroll', 'scrollintoview', 'drag', 'upload', 'download', 'screenshot', 'pdf', 'get', 'is', 'wait', 'eval', 'back', 'forward', 'reload', 'tab', 'frame', 'dialog', 'console', 'errors', 'highlight', 'close', 'find', 'mouse', 'touch', 'set'])

/** The flags that pick the browser's session, its saved state, or its policy, which Buckle alone sets. */
const SESSION_FLAGS = ['--session', '--namespace', '--restore', '--restore-save', '--state', '--load', '--credential-provider', '--action-policy']

/** Mode-neutral: a profile or an attached browser is the owner's choice, never one an agent's call can make. */
const SESSION_REFUSAL = 'Buckle\'s browser cannot attach, restore, or override session identity'

/** The sessions store's key for the one session every caller shares on a profile folder. */
const SHARED_PROFILE_KEY = JSON.stringify(['profile'])


/**
 * Fixed text, so the agent reads the same sentence whichever browser was reset. Only a fresh browser is passed
 * allowed domains, so only a fresh browser relaunches when they change.
 */
const RELAUNCH_NOTICE = 'The browser was relaunched because the allowed domains changed; open tabs and cookies were reset.'

const SessionsSchema = z.object({
  sessions: z.record(z.string(), z.string()),
  /** The --allowed-domains each session last ran with, null for none, so a change can be told. */
  allowedDomains: z.record(z.string(), z.string().nullable()).default({}),
  /** The settings each session's daemon was started with (modeFingerprint), so one from other settings is replaced. */
  modes: z.record(z.string(), z.string()).default({}),
  /** The process that wrote each session's settings, so a live sibling's daemon is reused rather than closed. */
  writers: z.record(z.string(), z.number().int()).default({}),
  /**
   * Each value a fill or type handed a browser of the workspace from a secret reference (docs/secrets.md), by file, NAME,
   * and sha256, never the value, so every Buckle process on the workspace masks the page by it, after a restart too;
   * absent while none is held. It ends with the workspace's last browser where closing ends the page (endsHold).
   */
  filled: z.array(z.object({ real: z.string(), written: z.string(), name: z.string(), digest: z.string() })).optional(),
})

type Sessions = z.infer<typeof SessionsSchema>

/** A fresh record each time, as a store's update may change the fallback it was handed. */
function emptySessions(): Sessions {
  return { sessions: {}, allowedDomains: {}, modes: {}, writers: {} }
}

/** How many filled values a workspace's browsers are masked by at most. */
const MAX_FILLED = 256

/**
 * The values the workspace's browsers hold from secret references, as its browser packs record them in sessions.json,
 * read again at each browser call (runWithSecrets), so a process beside the one that filled, or one started after it
 * stopped, masks the page too.
 */
export function browserFilledSecrets(sessionDirectory: string): FilledSecrets {
  const sessions = createJsonFileStore({ filePath: join(sessionDirectory, 'sessions.json'), schema: SessionsSchema, fallback: emptySessions() })
  return { list: () => sessions.read().filled ?? [] }
}

/** The record with a call's filled values in it, one entry a file and NAME, refused past MAX_FILLED. */
function withFilled(held: readonly FilledSecret[], added: readonly FilledSecret[]): FilledSecret[] {
  const entries = new Map(held.map(entry => [`${entry.real}\u0000${entry.name}`, entry]))
  for (const entry of added) {
    const key = `${entry.real}\u0000${entry.name}`
    if (!entries.has(key) && entries.size >= MAX_FILLED) throw new ToolInputError(`A workspace's browsers are masked by at most ${MAX_FILLED} filled secret values; end them with the close command to fill more`, { code: 'PERMISSION_DENIED' })
    entries.set(key, { real: entry.real, written: entry.written, name: entry.name, digest: entry.digest })
  }
  return [...entries.values()]
}

/**
 * Whether closing a browser ends the page it shows, and with the workspace's last one the hold its fills left: a fresh
 * or profile browser Buckle launched closes, while an attached Chrome only disconnects and keeps its pages.
 */
function endsHold(mode: BrowserMode | null): boolean {
  return mode?.kind !== 'attached'
}

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
  const sessions = createJsonFileStore({ filePath: join(options.sessionDirectory, 'sessions.json'), schema: SessionsSchema, fallback: emptySessions() })
  const configFile = join(options.sessionDirectory, 'fresh-config.json')
  const allowedDomains = browserAllowedDomains(options.approvedLists)
  const choice = options.browser ?? { mode: FRESH_BROWSER }
  const mode: BrowserMode | null = 'mode' in choice ? choice.mode : null
  // agent-browser's output names the endpoint or the profile folder when it cannot reach or open them.
  const scrub = settingScrubber(mode ?? FRESH_BROWSER)
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const fingerprint = modeFingerprint(mode ?? FRESH_BROWSER, { launchArgs: options.launchArgs, headed: options.headed, idleTimeoutMs })
  // agent-browser refuses --allowed-domains with a profile or an attached browser, so only a fresh one is passed the list.
  const flag = mode?.kind === 'fresh' && 'value' in allowedDomains ? allowedDomains.value : null
  const unavailableReason = options.agentBrowser.path !== null ? ('refusal' in choice ? choice.refusal : null) : browserUnavailable(options.agentBrowserCommand, options.agentBrowser)
  if (unavailableReason === null && mode) logContainmentOff(mode)
  // The browser daemons this pack started and has not closed, which outlive single calls and end at its shutdown. The
  // one browser on a profile folder is never among them: other Buckle processes share it, so only the close command
  // and its idle timeout end it.
  const opened = new Set<string>()
  // Q10: a profile folder or an attached Chrome serves one workspace at a time; read at each use, so a change is seen at once.
  const assertHeld = (running: BrowserMode): void => {
    const holder = running.kind === 'fresh' ? null : options.heldBy?.() ?? null
    if (holder !== null) throw new ToolExecutionError(heldRefusal(running, holder), { code: 'BROWSER_COMMAND_FAILED' })
  }
  return {
    id: PACK_ID,
    version: '1.0.0',
    skills: [loadPackSkill(PACK_ID)],
    // No path: the manifest carrying it is read with the agent token, and the configured path is the owner's.
    unavailableReason,
    close: () => closeSessions({ options, sessions, opened, forget: true, endsHold: endsHold(mode) }),
    retire: () => closeSessions({ options, sessions, opened, forget: false, endsHold: endsHold(mode) }),
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
            // Every caller shares the one browser on a profile folder. Elsewhere each caller, stage, and alias has its own,
            // keyed by the mode and its settings too, so no process ever reaches a session started in another mode.
            const key = running.kind === 'profile' ? SHARED_PROFILE_KEY : JSON.stringify([running.kind, fingerprint, context.sessionId, context.stageId ?? 'default', input.session ?? 'default'])
            const own = running.kind === 'profile' ? profileSession(running.directory) : null
            const { session, relaunchedFrom, replaced, sibling } = await sessions.update((state) => {
              // Recorded under the same lock as the session, before the browser is handed a value, so a close in another
              // process never ends a hold this call is about to need.
              if (context.secretFills && context.secretFills.length > 0) state.filled = withFilled(state.filled ?? [], context.secretFills)
              const known = state.sessions[key]
              // Only the shared profile key can hold other settings: every other key carries its own.
              const mismatch = known !== undefined && state.modes[key] !== fingerprint
              // A live Buckle process on other profile settings keeps its daemon: closing it would relaunch Chrome on each
              // call either makes. The same folder's session is reused; another folder's is left alone beside this one.
              const writer = state.writers[key]
              if (own !== null && mismatch && writer !== undefined && writer !== process.pid && processAlive(writer)) {
                return { session: own === known ? known : own, relaunchedFrom: undefined, replaced: null, sibling: true }
              }
              // A daemon keeps the --allowed-domains it was launched with, so a fresh session last run under another list
              // is relaunched as one from other settings is: closed, and a new one named, before this call runs, so the
              // notice is true, and the pack this one replaced, ending what it opened once its calls end, never reaches the
              // new one (fix brief 4, finding 9).
              const recorded = state.allowedDomains[key]
              const stale = running.kind === 'fresh' && input.command !== 'close' && known !== undefined && recorded !== undefined && recorded !== flag
              // A daemon started under other settings keeps them, so its session is closed and a new one named.
              const replaced = mismatch || stale ? known : null
              if (known === undefined || replaced !== null) state.sessions[key] = own ?? `buckle-${randomUUID()}`
              // A daemon starts under this list at this call's first command, whether the call then succeeds, fails, or
              // times out, so the list is recorded before it runs: a later change then relaunches it.
              if (input.command !== 'close') state.allowedDomains[key] = flag
              state.modes[key] = fingerprint
              state.writers[key] = process.pid
              return { session: state.sessions[key]!, relaunchedFrom: stale ? recorded : undefined, replaced, sibling: false }
            })
            if (sibling) logSiblingSettings(options.serviceInstalled?.() === true)
            if (replaced !== null) {
              opened.delete(replaced)
              const closed = await closeSession(options, replaced, AbortSignal.timeout(CLOSE_TIMEOUT_MS))
              if (!closed) logger.warn('A browser session from other settings did not close; its idle timeout ends it')
            }
            // Tracked before it runs, for the same reason: a daemon a failed first call started is still ended by the
            // retire of the pack a change replaces, and by the node's shutdown.
            if (running.kind !== 'profile' && input.command !== 'close') opened.add(session)
            args.push('--config', configFile, '--session', session, ...modeArguments(running, { flag, headed: options.headed && !input.args.includes('--headed'), launchArgs: options.launchArgs, idleTimeoutMs }))
            if (flag !== null && 'loosened' in allowedDomains) logLoosened(allowedDomains.loosened)

            writeFileSync(configFile, '{}\n', { mode: 0o600 })
            const program = browserProgram(options)
            const ran = await options.runProcess({
              command: program.path,
              argv0: program.argv0,
              args: [...program.args, ...args],
              cwd: options.sessionDirectory,
              timeoutMs: context.timeoutMs,
              environment: browserEnvironment(options),
              signal: context.signal,
            })
            const failed = ran.exitCode !== 0
            const result = { ...ran, stdout: scrub(transfer.shown(ran.stdout), failed), stderr: scrub(transfer.shown(ran.stderr), failed) }
            if (result.exitCode !== 0) {
              throw new ToolExecutionError(describeProcessFailure('agent-browser', result), { code: 'BROWSER_COMMAND_FAILED' })
            }
            await transfer.deliver()
            if (input.command === 'close') {
              opened.delete(session)
              // The entry is forgotten only while it names this session: on another profile folder beside a live sibling,
              // the shared key still records the sibling's.
              await sessions.update((state) => {
                if (state.sessions[key] !== session) return
                delete state.sessions[key]
                delete state.allowedDomains[key]
                delete state.modes[key]
                delete state.writers[key]
                if (endsHold(running) && Object.keys(state.sessions).length === 0) delete state.filled
              })
            }
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

/** Refuses a command Buckle does not run, or a flag that would choose the session, its saved state, or its policy. */
function assertRunnable(input: { command: string; args: string[] }): void {
  if (!FRESH_COMMANDS.has(input.command)) throw new ToolInputError(`${input.command} is not run: ${SESSION_REFUSAL}`)
  const identity = input.args.map(arg => arg.split('=')[0]!.toLowerCase()).find(name => SESSION_FLAGS.includes(name))
  if (identity) throw new ToolInputError(`${identity} is not allowed: ${SESSION_REFUSAL}`)
}

/** The mode a call runs in; a pack whose profile folder was refused is withheld, so no call reaches here without one. */
function browserMode(mode: BrowserMode | null): BrowserMode {
  if (mode === null) throw new ToolExecutionError('BUCKLE_BROWSER_PROFILE names a folder Buckle does not load', { code: 'BROWSER_COMMAND_FAILED' })
  return mode
}

/**
 * The flags each mode adds after the session. A fresh browser takes the allowed domains; a profile folder takes
 * --profile instead, as agent-browser refuses the two together; both take the owner's --args and --headed. An
 * attached browser takes --cdp alone: it keeps the profile, arguments, and window its owner started it with, and
 * agent-browser's close and idle shutdown only disconnect from it.
 */
function modeArguments(mode: BrowserMode, input: { flag: string | null; headed: boolean; launchArgs: string | undefined; idleTimeoutMs: number }): string[] {
  const args = ['--idle-timeout', String(input.idleTimeoutMs)]
  if (mode.kind === 'attached') return [...args, '--cdp', mode.endpoint]
  if (mode.kind === 'profile') args.push('--profile', mode.directory)
  if (input.flag !== null) args.push('--allowed-domains', input.flag)
  if (input.launchArgs) args.push('--args', input.launchArgs)
  if (input.headed) args.push('--headed')
  return args
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

/** How long shutdown waits for the browser daemons to close, all of them together. */
const CLOSE_TIMEOUT_MS = 5_000

/**
 * Closes each browser this pack started, as the close command would, so no daemon outlives the pack by its idle
 * timeout. They close in parallel under one bound, so a few stuck daemons cannot outlast the close step before the
 * store is updated (review L10 of B18-B19). A daemon that will not close is left to that timeout, with a warning. At
 * shutdown (`forget`) each session is forgotten too; a pack replaced by one built from other settings keeps the
 * records instead (fix brief 2, R2): the successor finds each session's key and the list it last ran under, and at the
 * session's next call closes it and starts a browser under a new name and the new list, saying it was relaunched.
 */
async function closeSessions(input: { options: BrowserPackOptions; sessions: JsonFileStore<Sessions>; opened: Set<string>; forget: boolean; endsHold: boolean }): Promise<void> {
  const closing = [...input.opened]
  input.opened.clear()
  if (closing.length === 0) return
  const bound = AbortSignal.timeout(CLOSE_TIMEOUT_MS)
  const closed = await Promise.all(closing.map(async (session) => {
    const done = await closeSession(input.options, session, bound)
    if (!done) logger.warn(input.forget ? 'A browser session did not close at shutdown; its idle timeout ends it' : 'A browser session did not close when its settings changed; its idle timeout ends it')
    return done
  }))
  if (!input.forget) return
  await input.sessions.update((state) => {
    for (const [key, session] of Object.entries(state.sessions)) {
      if (!closing.includes(session)) continue
      delete state.sessions[key]
      delete state.allowedDomains[key]
      delete state.modes[key]
      delete state.writers[key]
    }
    // A browser that would not close may still show a filled page until its idle timeout, so the hold stays.
    if (input.endsHold && closed.every(Boolean) && Object.keys(state.sessions).length === 0) delete state.filled
  })
}

/**
 * Sends close to one session's daemon, as the close command would: it closes a browser agent-browser launched and
 * only disconnects from an attached one. Whether it closed; a daemon that will not is left to its idle timeout.
 */
async function closeSession(options: BrowserPackOptions, session: string, signal: AbortSignal): Promise<boolean> {
  const program = browserProgram(options)
  const result = await options.runProcess({
    command: program.path,
    argv0: program.argv0,
    args: [...program.args, 'close', '--session', session, '--json'],
    cwd: options.sessionDirectory,
    timeoutMs: CLOSE_TIMEOUT_MS,
    environment: browserEnvironment(options),
    signal,
  }).catch(() => ({ exitCode: null }))
  return result.exitCode === 0
}

/**
 * Whether a process this user runs is alive: a Buckle sibling runs as the owner, so one Buckle may not signal (EPERM)
 * is another user's, and the session it wrote is the owner's to replace. A signal of 0 tests and sends nothing.
 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

let loggedSibling = false

/** Once per process: fixed text naming the settings, never their values. */
function logSiblingSettings(serviceInstalled: boolean): void {
  if (loggedSibling) return
  loggedSibling = true
  logger.warn(`Another Buckle process on this node runs the browser under other BUCKLE_BROWSER_CDP, BUCKLE_BROWSER_PROFILE, BUCKLE_BROWSER_ARGS, or BUCKLE_BROWSER_HEADED settings; its browser session is reused, not closed. Restart every Buckle process on the node after changing them${serviceInstalled ? ': buckle service restart for the service, and each buckle mcp through its client' : ''}`)
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
