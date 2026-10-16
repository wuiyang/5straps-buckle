import { join } from 'pathe'
import { ServiceManagerError, type ServiceDefinition } from '../types/ports/service-manager.js'
import { SKIP_OWNER_ONLY_FLAG } from './global-flags.js'

/**
 * The one Buckle agent a machine has (D85 Q4, owner ruling of 2026-10-17, "macOS find equivalent of Linux"): a launchd
 * agent in the owner's login session, the macOS counterpart of the systemd user unit, so it runs as the owner, at login.
 */
export const LAUNCHD_LABEL = 'com.5straps.buckle'

/** Where launchd reads the owner's agents at login. */
export function launchdAgentDirectory(home: string): string {
  return join(home, 'Library', 'LaunchAgents')
}

/** The property list `buckle service install` writes: ~/Library/LaunchAgents/com.5straps.buckle.plist. */
export function launchdAgentPath(home: string): string {
  return join(launchdAgentDirectory(home), `${LAUNCHD_LABEL}.plist`)
}

/**
 * Every path that changes what Buckle's agent runs at the next login, which the file tools refuse to read or write
 * (protectedStateRoots): the agent's property list. Another file in the folder asks like any other file.
 */
export function launchdGuardedPaths(home: string): string[] {
  return [launchdAgentPath(home)]
}

/**
 * Where launchd sends what a node writes before it opens its own log, its standard output and error: the role the
 * systemd journal has on Linux. In the state directory, owner-only, and rotated by nobody (known-limits-05).
 */
export function launchdLogPath(stateDirectory: string): string {
  return join(stateDirectory, 'logs', 'launchd.log')
}

/**
 * The agent, as the property list launchd reads: ProgramArguments runs the absolute Node binary with the absolute
 * main.js and `serve`, naming the state directory and any environment file as paths, each its own string, so no shell
 * and no command line is read; PATH is the installing shell's, as the unit's `Environment=PATH=` (launchd sets HOME and
 * TMPDIR itself); it works in the state directory, starts at login and when loaded, restarts five seconds after a
 * failure (`Restart=on-failure`, `RestartSec=5`), runs at the standard priority, and creates files owner-only, as the
 * unit's `UMask=0077`. Nothing in it is a setting's value: the node reads those from its own file.
 */
export function renderAgent(definition: ServiceDefinition): string {
  for (const path of [definition.node, definition.main, definition.stateDirectory, definition.environmentFile, definition.path]) {
    if (path && /[\u0000-\u001f\u007f]/.test(path)) throw new ServiceManagerError('A path the service would name holds a control character, so Buckle writes no agent for it')
  }
  const programArguments = [definition.node, definition.main, 'serve', '--service', 'launchd', '--state-dir', definition.stateDirectory,
    ...(definition.environmentFile ? ['--env-file', definition.environmentFile] : []), ...(definition.skipOwnerOnlyCheck ? [SKIP_OWNER_ONLY_FLAG] : [])]
  const log = xml(launchdLogPath(definition.stateDirectory))
  const environment = definition.path ? `\t<key>EnvironmentVariables</key>\n\t<dict>\n\t\t<key>PATH</key>\n\t\t<string>${xml(definition.path)}</string>\n\t</dict>\n` : ''
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by buckle service install, which writes it again; buckle service uninstall removes it. -->
<!-- It names paths only: the node reads its settings from its own environment file. -->
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LAUNCHD_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
${programArguments.map(argument => `\t\t<string>${xml(argument)}</string>\n`).join('')}\t</array>
\t<key>WorkingDirectory</key>
\t<string>${xml(definition.stateDirectory)}</string>
${environment}\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>ThrottleInterval</key>
\t<integer>5</integer>
\t<key>StandardOutPath</key>
\t<string>${log}</string>
\t<key>StandardErrorPath</key>
\t<string>${log}</string>
\t<key>ProcessType</key>
\t<string>Standard</string>
\t<key>Umask</key>
\t<integer>63</integer>
</dict>
</plist>
`
}

/** A string as XML text: the five characters XML reserves, each as its entity. */
function xml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** XML text as the string it holds: the five entities and numeric references, read in one pass. */
function unxml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#[0-9]{1,7}|#x[0-9a-fA-F]{1,6});/g, (whole, name: string) => {
    if (!name.startsWith('#')) return ENTITIES[name]!
    const code = name[1] === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole
  })
}

/** What an agent's ProgramArguments run, read back as renderAgent writes them; null fields where it does not say. */
export function readAgent(text: string): { node: string | null; main: string | null; stateDirectory: string | null; skipsOwnerOnlyCheck: boolean } {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1]
  const words = array === undefined ? [] : [...array.matchAll(/<string>([^<]*)<\/string>/g)].map(match => unxml(match[1]!))
  const at = words.indexOf('--state-dir')
  return { node: words[0] ?? null, main: words[1] ?? null, stateDirectory: at === -1 ? null : words[at + 1] ?? null, skipsOwnerOnlyCheck: words.includes(SKIP_OWNER_ONLY_FLAG) }
}
