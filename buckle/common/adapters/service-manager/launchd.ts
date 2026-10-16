import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { dirname } from 'pathe'
import { buildChildEnvironment } from '../../domain/environment.js'
import { LAUNCHD_LABEL, launchdAgentDirectory, launchdAgentPath, launchdLogPath, readAgent, renderAgent } from '../../domain/launchd-agent.js'
import { homeDirectory } from '../../domain/paths.js'
import { sameDirectory } from '../../runtime/config.js'
import type { ProcessRunner } from '../../types/ports/process-runner.js'
import { ServiceManagerError, type InstalledService, type NodeLocation, type ServiceManager } from '../../types/ports/service-manager.js'
import { replaceFile } from '../json-file-store.js'

/** Where launchctl is, by absolute path, so neither PATH nor the working directory chooses the program. */
export const LAUNCHCTL = '/bin/launchctl'
const QUICK_MS = 30_000
/** Stopping waits for the node's close stages, as systemd.ts waits for its user manager's stop. */
const STOPPING_MS = 120_000
/** How often an unload is checked for having ended, where launchctl answered before the node did. */
const UNLOAD_POLL_MS = 250

/**
 * macOS's service manager (D85 Q4, owner ruling of 2026-10-17): launchd, driven through launchctl by its absolute path
 * with no shell and the fixed list of variables every child gets, nothing added. The agent lives in the owner's login
 * session, the domain `gui/<uid>`, so it starts at login with the desktop there; a start at boot would be a daemon that
 * runs as root, which Buckle does not write, so it has no beforeLogin.
 *
 * launchd runs the definition it loaded, not the file as it is now, so every start loads the file afresh: an agent
 * already loaded is unloaded first (bootout, which ends its node with SIGTERM), then loaded (bootstrap, which starts it,
 * as RunAtLoad says). A later `buckle service install` without --now, or one after Node moved, is then what runs.
 */
export function createLaunchdManager(input: { environment: NodeJS.ProcessEnv; run: ProcessRunner; location: NodeLocation; launchctl?: string; uid?: number; home?: string }): ServiceManager {
  const launchctlPath = input.launchctl ?? LAUNCHCTL
  // Every macOS process has a user id; 0 only where a test on another platform builds this adapter.
  const domain = `gui/${input.uid ?? process.getuid?.() ?? 0}`
  const service = `${domain}/${LAUNCHD_LABEL}`
  const home = input.home ?? homeDirectory('darwin')
  const agent = launchdAgentPath(home)
  const environment = buildChildEnvironment({ parent: input.environment, extra: {}, platform: 'darwin' })

  async function launchctl(args: string[], timeoutMs = QUICK_MS): Promise<{ exitCode: number | null; stdout: string }> {
    try {
      const result = await input.run({ command: launchctlPath, args, cwd: '/', timeoutMs, environment })
      return { exitCode: result.exitCode, stdout: result.stdout }
    } catch (error) {
      throw new ServiceManagerError(`launchctl could not run (${(error as NodeJS.ErrnoException).code ?? 'unknown error'})`)
    }
  }

  /** A failed launchctl call, named by its verb and exit code alone (never the path it was given), and where to look. */
  function failed(verb: string, exitCode: number | null): ServiceManagerError {
    return new ServiceManagerError(`launchctl ${verb} failed (exit code ${exitCode ?? 'none'}); launchctl print ${service} says why`)
  }

  async function required(args: string[]): Promise<void> {
    const result = await launchctl(args)
    if (result.exitCode !== 0) throw failed(args[0]!, result.exitCode)
  }

  /** Whether launchd holds the agent in the owner's login session now. */
  async function loaded(): Promise<boolean> {
    return (await launchctl(['print', service])).exitCode === 0
  }

  /** Whether the owner disabled the agent (`launchctl disable`), which keeps it from loading at login. */
  async function disabled(): Promise<boolean> {
    const answer = await launchctl(['print-disabled', domain]).catch(() => null)
    // Older macOS writes `=> true` for a disabled service, newer `=> disabled`.
    return answer?.exitCode === 0 && /"com\.5straps\.buckle"\s*=>\s*(?:true|disabled)\b/.test(answer.stdout)
  }

  /**
   * Unloads the agent, which ends its node with SIGTERM, and waits until launchd holds it no more. A failure where it
   * was not loaded is none; launchctl may also answer while the node is still ending, so it is done once print no
   * longer finds the agent, and failed only where launchd still holds it after the stop wait.
   */
  async function bootout(): Promise<void> {
    const result = await launchctl(['bootout', service], STOPPING_MS)
    const deadline = Date.now() + STOPPING_MS
    while (await loaded()) {
      if (Date.now() >= deadline) throw failed('bootout', result.exitCode)
      await delay(UNLOAD_POLL_MS)
    }
  }

  /**
   * Loads the agent from the file, unloading an earlier load first, which starts its node. Where something else loaded
   * it in between, launchd answers that it is already loaded: that load is the file's too, so it is started where it
   * does not run (kickstart without -k).
   */
  async function load(): Promise<void> {
    await bootout()
    const result = await launchctl(['bootstrap', domain, agent])
    if (result.exitCode === 0) return
    if (!await loaded()) throw failed('bootstrap', result.exitCode)
    await required(['kickstart', service])
  }

  /** The agent written owner-only through a temporary file, in a folder made where missing (an existing one keeps its mode). */
  async function writeAgent(text: string): Promise<void> {
    mkdirSync(launchdAgentDirectory(home), { recursive: true, mode: 0o700 })
    const temporary = `${agent}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' })
      await replaceFile(temporary, agent)
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  return {
    kind: 'launchd',
    label: `the launchd agent ${LAUNCHD_LABEL}`,
    async unavailable() {
      if (!existsSync(launchctlPath)) return 'No launchd login session answers here (launchctl is missing)'
      if ((await launchctl(['print', domain])).exitCode === 0) return null
      return `No launchd login session answers here (launchctl print ${domain} failed): this user has not logged in at the Mac, as over SSH before a login`
    },
    async installed(): Promise<InstalledService | null> {
      if (!existsSync(agent)) return null
      const { node, main, stateDirectory, skipsOwnerOnlyCheck } = readAgent(readFileSync(agent, 'utf8'))
      return { node, main, thisNode: stateDirectory === null ? null : sameDirectory(stateDirectory, input.location.stateDirectory, 'darwin'), enabled: !await disabled(), ...(skipsOwnerOnlyCheck ? { skipsOwnerOnlyCheck } : {}) }
    },
    async install(definition, options) {
      await writeAgent(renderAgent(definition))
      // launchd opens the log itself and creates it with its own mode; made here first, it is owner-only from the start.
      const log = launchdLogPath(definition.stateDirectory)
      mkdirSync(dirname(log), { recursive: true, mode: 0o700 })
      closeSync(openSync(log, 'a', 0o600))
      await required(['enable', service])
      // Without now, launchd loads it at the next login.
      if (options.now) await load()
    },
    async uninstall() {
      await bootout()
      rmSync(agent, { force: true })
    },
    start: load,
    // Unloads it until the next login or start, as systemctl stop leaves an enabled unit.
    stop: bootout,
    restart: load,
  }
}
