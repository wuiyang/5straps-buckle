import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'pathe'
import { buildChildEnvironment } from '../../domain/environment.js'
import { findExecutable } from '../../domain/executable.js'
import { homeDirectory } from '../../domain/paths.js'
import { sameDirectory } from '../../runtime/config.js'
import type { ProcessRunner } from '../../types/ports/process-runner.js'
import { SERVE_REFUSED_EXIT, ServiceManagerError, type InstalledService, type NodeLocation, type ServiceDefinition, type ServiceManager } from '../../types/ports/service-manager.js'
import { replaceFile } from '../json-file-store.js'

/** The one Buckle unit a machine has (Phase 3, Q4): a systemd user unit, so it runs as the owner, at login. */
export const SYSTEMD_UNIT = 'buckle.service'
const SYSTEMCTL = 'systemctl'
const QUICK_MS = 30_000
/** Stopping waits for the node's close stages, which systemd bounds by its own stop timeout, 90 seconds by default. */
const STOPPING_MS = 120_000
/** What systemctl needs to reach the user manager besides the fixed list every child gets; none holds a secret. */
const SESSION_VARIABLES = ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'] as const

/** Where the user manager reads the owner's units: $XDG_CONFIG_HOME/systemd/user, or ~/.config/systemd/user. */
export function systemdUnitDirectory(environment: NodeJS.ProcessEnv, home: string = homeDirectory('linux')): string {
  const config = environment.XDG_CONFIG_HOME
  return join(config && isAbsolute(config) ? config : join(home, '.config'), 'systemd', 'user')
}

/**
 * The paths that start Buckle at login: the unit, and the link `enable` makes to it, which the file tools refuse to
 * write (protectedStateRoots), so no agent rewrites what runs at the next login.
 */
export function systemdUnitPaths(environment: NodeJS.ProcessEnv, home?: string): string[] {
  const directory = systemdUnitDirectory(environment, home)
  return [join(directory, SYSTEMD_UNIT), join(directory, 'default.target.wants', SYSTEMD_UNIT)]
}

/**
 * The unit (Phase 3, item 2): ExecStart runs the absolute Node binary with the absolute main.js and `serve`, naming the
 * state directory and any environment file as paths; PATH is the installing shell's, so the node finds the programs the
 * owner's terminal finds; it works in the state directory, restarts on a failure but not on a refusal to run beside
 * another node, and stops on SIGTERM. Nothing in it is a setting's value: the node reads those from its own file.
 */
export function renderUnit(definition: ServiceDefinition): string {
  for (const path of [definition.node, definition.main, definition.stateDirectory, definition.environmentFile, definition.path]) {
    if (path && /[\u0000-\u001f\u007f]/.test(path)) throw new ServiceManagerError('A path the service would name holds a control character, so Buckle writes no unit for it')
  }
  const command = [quoted(definition.node), quoted(definition.main), 'serve', '--service', 'systemd', '--state-dir', quoted(definition.stateDirectory),
    ...(definition.environmentFile ? ['--env-file', quoted(definition.environmentFile)] : [])].join(' ')
  return `# Written by buckle service install, which writes it again; buckle service uninstall removes it.
# It names paths only: the node reads its settings from its own environment file.
[Unit]
Description=5straps Buckle, the local permission node

[Service]
Type=simple
ExecStart=${command}
${definition.path ? `Environment=${quotedSetting(`PATH=${definition.path}`)}\n` : ''}WorkingDirectory=${definition.stateDirectory.replaceAll('%', '%%')}
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=${SERVE_REFUSED_EXIT}
KillSignal=SIGTERM
UMask=0077

[Install]
WantedBy=default.target
`
}

/** An ExecStart word in double quotes: a backslash and a quote escaped, `%` doubled (a specifier), `$` doubled (a variable). */
function quoted(word: string): string {
  return `"${word.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$$$')}"`
}

/** An Environment= assignment in double quotes: specifiers are expanded there too, and `$` is not. */
function quotedSetting(assignment: string): string {
  return `"${assignment.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`
}

/** What a unit's ExecStart runs, read back as renderUnit writes it; null fields where it does not say. */
export function readUnit(text: string): { node: string | null; main: string | null; stateDirectory: string | null } {
  const line = /^ExecStart=(.*)$/m.exec(text)?.[1]
  const words = line === undefined ? [] : execWords(line)
  const at = words.indexOf('--state-dir')
  return { node: words[0] ?? null, main: words[1] ?? null, stateDirectory: at === -1 ? null : words[at + 1] ?? null }
}

/** ExecStart's words: double-quoted with backslash escapes, or bare; `%%` and `$$` read as one character. */
function execWords(line: string): string[] {
  const words: string[] = []
  for (const match of line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
    const raw = match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : match[2]!
    words.push(raw.replaceAll('%%', '%').replaceAll('$$', '$'))
  }
  return words
}

/**
 * Linux's service manager (Phase 3, item 2): the systemd user manager, driven through `systemctl --user`, found on
 * PATH and started with no shell and an environment of the fixed list every child gets plus the session's address.
 */
export function createSystemdManager(input: { environment: NodeJS.ProcessEnv; run: ProcessRunner; location: NodeLocation; home?: string; cwd?: string }): ServiceManager {
  const unitDirectory = systemdUnitDirectory(input.environment, input.home)
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
      const { node, main, stateDirectory } = readUnit(readFileSync(unit, 'utf8'))
      return { node, main, thisNode: stateDirectory === null ? null : sameDirectory(stateDirectory, input.location.stateDirectory, 'linux'), enabled }
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
  }
}
