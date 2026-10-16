import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'pathe'
import { buildChildEnvironment } from '../../domain/environment.js'
import { findExecutable } from '../../domain/executable.js'
import { homeDirectory } from '../../domain/paths.js'
import { readUnit, renderUnit, SYSTEMD_UNIT, systemdUnitDirectory } from '../../domain/systemd-unit.js'
import { sameDirectory } from '../../runtime/config.js'
import type { ProcessRunner } from '../../types/ports/process-runner.js'
import { ServiceManagerError, type InstalledService, type NodeLocation, type ServiceManager } from '../../types/ports/service-manager.js'
import { replaceFile } from '../json-file-store.js'

const SYSTEMCTL = 'systemctl'
const QUICK_MS = 30_000
/** Stopping waits for the node's close stages, which systemd bounds by its own stop timeout, 90 seconds by default. */
const STOPPING_MS = 120_000
/** What systemctl needs to reach the user manager besides the fixed list every child gets; none holds a secret. */
const SESSION_VARIABLES = ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'] as const
/** Where systemd-logind marks a user whose manager starts at boot (`loginctl enable-linger`). */
const LINGER_DIRECTORY = '/var/lib/systemd/linger'

/**
 * Linux's service manager (Phase 3, item 2): the systemd user manager, driven through `systemctl --user`, found on
 * PATH and started with no shell and an environment of the fixed list every child gets plus the session's address.
 */
export function createSystemdManager(input: { environment: NodeJS.ProcessEnv; run: ProcessRunner; location: NodeLocation; home?: string; cwd?: string; lingerDirectory?: string }): ServiceManager {
  const unitDirectory = systemdUnitDirectory(input.environment, input.home ?? homeDirectory('linux'))
  const unit = join(unitDirectory, SYSTEMD_UNIT)
  const environment = buildChildEnvironment({ parent: input.environment, extra: Object.fromEntries(SESSION_VARIABLES.flatMap(name => input.environment[name] ? [[name, input.environment[name]!]] : [])), platform: 'linux' })

  async function systemctl(args: string[], timeoutMs = QUICK_MS): Promise<{ exitCode: number | null; stdout: string }> {
    const program = findExecutable(SYSTEMCTL, input.environment, 'linux')
    if (program === null) throw new ServiceManagerError('systemctl was not found on PATH, so Buckle cannot reach the systemd user manager')
    const result = await input.run({ command: program, args: ['--user', ...args], cwd: input.cwd ?? homeDirectory('linux'), timeoutMs, environment })
    return { exitCode: result.exitCode, stdout: result.stdout }
  }

  async function required(args: string[], timeoutMs = QUICK_MS): Promise<void> {
    const result = await systemctl(args, timeoutMs)
    if (result.exitCode !== 0) throw new ServiceManagerError(`systemctl --user ${args.join(' ')} failed (exit code ${result.exitCode ?? 'none'}); systemctl --user status ${SYSTEMD_UNIT} and journalctl --user -u ${SYSTEMD_UNIT} say why`)
  }

  return {
    kind: 'systemd',
    label: `the systemd user unit ${SYSTEMD_UNIT}`,
    async unavailable() {
      if (!input.environment.XDG_RUNTIME_DIR) return 'No systemd user session answers here (XDG_RUNTIME_DIR is not set)'
      if (findExecutable(SYSTEMCTL, input.environment, 'linux') === null) return 'No systemd user session answers here (systemctl is not on PATH)'
      const answer = await systemctl(['show', '--property=Version'])
      return answer.exitCode === 0 ? null : 'No systemd user session answers here (systemctl --user did not answer)'
    },
    async installed(): Promise<InstalledService | null> {
      if (!existsSync(unit)) return null
      const enabled = (await systemctl(['is-enabled', SYSTEMD_UNIT]).catch(() => ({ exitCode: 1 }))).exitCode === 0
      const { node, main, stateDirectory, skipsOwnerOnlyCheck } = readUnit(readFileSync(unit, 'utf8'))
      return { node, main, thisNode: stateDirectory === null ? null : sameDirectory(stateDirectory, input.location.stateDirectory, 'linux'), enabled, ...(skipsOwnerOnlyCheck ? { skipsOwnerOnlyCheck } : {}) }
    },
    async install(definition, options) {
      const text = renderUnit(definition)
      mkdirSync(unitDirectory, { recursive: true, mode: 0o700 })
      const temporary = `${unit}.${randomUUID()}.tmp`
      try {
        writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' })
        await replaceFile(temporary, unit)
      } finally {
        rmSync(temporary, { force: true })
      }
      await required(['daemon-reload'])
      await required(['enable', SYSTEMD_UNIT])
      // A restart starts it where it is stopped, and replaces a node an earlier install started with this definition's.
      if (options.now) await required(['restart', SYSTEMD_UNIT], STOPPING_MS)
    },
    async uninstall() {
      await systemctl(['stop', SYSTEMD_UNIT], STOPPING_MS)
      await systemctl(['disable', SYSTEMD_UNIT])
      rmSync(unit, { force: true })
      await required(['daemon-reload'])
      await systemctl(['reset-failed', SYSTEMD_UNIT])
    },
    start: () => required(['start', SYSTEMD_UNIT]),
    stop: () => required(['stop', SYSTEMD_UNIT], STOPPING_MS),
    restart: () => required(['restart', SYSTEMD_UNIT], STOPPING_MS),
    // The user manager starts at login; lingering, the system's own setting, starts it at boot. Buckle names the
    // command and never runs it, as it may ask for an administrator's authentication.
    async beforeLogin() {
      const user = input.environment.USER || input.environment.LOGNAME || userInfo().username
      return { starts: existsSync(join(input.lingerDirectory ?? LINGER_DIRECTORY, user)), command: `loginctl enable-linger ${user}` }
    },
  }
}
