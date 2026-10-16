import { isAbsolute, join } from 'pathe'
import { SERVE_REFUSED_EXIT, ServiceManagerError, type ServiceDefinition } from '../types/ports/service-manager.js'

/** The one Buckle unit a machine has (Phase 3, Q4): a systemd user unit, so it runs as the owner, at login. */
export const SYSTEMD_UNIT = 'buckle.service'

/** Where the user manager reads the owner's units: $XDG_CONFIG_HOME/systemd/user, or ~/.config/systemd/user. */
export function systemdUnitDirectory(environment: NodeJS.ProcessEnv, home: string): string {
  const config = environment.XDG_CONFIG_HOME
  return join(config && isAbsolute(config) ? config : join(home, '.config'), 'systemd', 'user')
}

/**
 * The paths that start Buckle at login: the unit, and the link `enable` makes to it, which the file tools refuse to
 * write (protectedStateRoots), so no agent rewrites what runs at the next login.
 */
export function systemdUnitPaths(environment: NodeJS.ProcessEnv, home: string): string[] {
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
