import { describe, expect, it } from 'vitest'
import { launchdAgentPath, launchdGuardedPaths, launchdLogPath, readAgent, renderAgent } from '../common/domain/launchd-agent.js'
import { ServiceManagerError } from '../common/types/ports/service-manager.js'

// D85 Q4, owner ruling of 2026-10-17 ("macOS find equivalent of Linux"): on macOS, a launchd agent, the counterpart of
// the systemd user unit. No launchd runs here or on CI, so the agent is checked as the text launchd reads, and launchctl
// is imitated at an injected path; no Mac has run any of it yet (known-limits-05).

const DEFINITION = { node: '/opt/node v24/bin/node', main: '/usr/local/lib/node_modules/@5straps/buckle/dist/main.js', stateDirectory: '/Users/owner/.5straps/buckle', environmentFile: null, path: '/Users/owner/.local/bin:/usr/local/bin:/usr/bin:/bin' }

describe('the launchd agent', () => {
  it('runs this Node and main.js with serve as separate strings, names where the node lives, and restarts on a failure alone', () => {
    expect(renderAgent(DEFINITION)).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by buckle service install, which writes it again; buckle service uninstall removes it. -->
<!-- It names paths only: the node reads its settings from its own environment file. -->
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>com.5straps.buckle</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/opt/node v24/bin/node</string>
\t\t<string>/usr/local/lib/node_modules/@5straps/buckle/dist/main.js</string>
\t\t<string>serve</string>
\t\t<string>--service</string>
\t\t<string>launchd</string>
\t\t<string>--state-dir</string>
\t\t<string>/Users/owner/.5straps/buckle</string>
\t</array>
\t<key>WorkingDirectory</key>
\t<string>/Users/owner/.5straps/buckle</string>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>/Users/owner/.local/bin:/usr/local/bin:/usr/bin:/bin</string>
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>ThrottleInterval</key>
\t<integer>5</integer>
\t<key>StandardOutPath</key>
\t<string>/Users/owner/.5straps/buckle/logs/launchd.log</string>
\t<key>StandardErrorPath</key>
\t<string>/Users/owner/.5straps/buckle/logs/launchd.log</string>
\t<key>ProcessType</key>
\t<string>Standard</string>
\t<key>Umask</key>
\t<integer>63</integer>
</dict>
</plist>
`)
  })

  it('escapes each character XML reserves in every string, and reads odd paths back as they were', () => {
    const odd = { node: '/opt/Node & Co/bin/node', main: '/Users/o\'neil/<lib>/"x"\\main.js', stateDirectory: '/Users/zoë/state 100% > here', environmentFile: '/Users/zoë/a&b "c".env', path: '/opt/<p>:/usr/bin' }
    const agent = renderAgent(odd)
    expect(agent).toContain('\t\t<string>/opt/Node &amp; Co/bin/node</string>\n\t\t<string>/Users/o&apos;neil/&lt;lib&gt;/&quot;x&quot;\\main.js</string>\n')
    expect(agent).toContain('\t\t<string>--state-dir</string>\n\t\t<string>/Users/zoë/state 100% &gt; here</string>\n\t\t<string>--env-file</string>\n\t\t<string>/Users/zoë/a&amp;b &quot;c&quot;.env</string>\n\t</array>\n')
    expect(agent).toContain('\t<key>WorkingDirectory</key>\n\t<string>/Users/zoë/state 100% &gt; here</string>\n')
    expect(agent).toContain('\t\t<string>/opt/&lt;p&gt;:/usr/bin</string>\n')
    expect(agent).toContain('\t<string>/Users/zoë/state 100% &gt; here/logs/launchd.log</string>\n')
    // Every string element holds escaped text alone, so no path closes one early or opens another.
    for (const [, text] of agent.matchAll(/<string>([^<]*)<\/string>/g)) expect(text).not.toMatch(/[<>"']|&(?!amp;|lt;|gt;|quot;|apos;)/)
    expect(readAgent(agent)).toEqual({ node: odd.node, main: odd.main, stateDirectory: odd.stateDirectory, skipsOwnerOnlyCheck: false })
  })

  it('carries --skip-owner-only-check as the last argument where the install had it, and reads it back', () => {
    const skipped = renderAgent({ ...DEFINITION, environmentFile: '/srv/node.env', skipOwnerOnlyCheck: true })
    expect(skipped).toContain('\t\t<string>--env-file</string>\n\t\t<string>/srv/node.env</string>\n\t\t<string>--skip-owner-only-check</string>\n\t</array>\n')
    expect(readAgent(skipped)).toEqual({ node: DEFINITION.node, main: DEFINITION.main, stateDirectory: DEFINITION.stateDirectory, skipsOwnerOnlyCheck: true })
    expect(renderAgent({ ...DEFINITION, skipOwnerOnlyCheck: false })).toBe(renderAgent(DEFINITION))
  })

  it('names no environment where the shell had no PATH, and refuses a path holding a control character', () => {
    const { path: _none, ...noPath } = DEFINITION
    expect(renderAgent(noPath)).not.toContain('EnvironmentVariables')
    expect(() => renderAgent({ ...DEFINITION, stateDirectory: '/Users/owner/state\n</string><string>--evil' })).toThrow(new ServiceManagerError('A path the service would name holds a control character, so Buckle writes no agent for it'))
    expect(() => renderAgent({ ...DEFINITION, path: '/usr/bin\u007f' })).toThrow(ServiceManagerError)
  })

  it('reads an agent that does not say where its node lives as naming nothing, and numeric references as their characters', () => {
    expect(readAgent('<plist><dict><key>ProgramArguments</key><array><string>/usr/bin/node</string><string>/srv/main.js</string><string>serve</string></array></dict></plist>')).toEqual({ node: '/usr/bin/node', main: '/srv/main.js', stateDirectory: null, skipsOwnerOnlyCheck: false })
    expect(readAgent('<plist><dict><key>Label</key><string>com.5straps.buckle</string></dict></plist>')).toEqual({ node: null, main: null, stateDirectory: null, skipsOwnerOnlyCheck: false })
    expect(readAgent('<key>ProgramArguments</key>\n<array>\n<string>/usr/bin/node</string>\n<string>/srv/main.js</string>\n<string>--state-dir</string>\n<string>/Users/zo&#235;/&#x26;s</string>\n</array>').stateDirectory).toBe('/Users/zoë/&s')
  })

  it('lives where launchd reads the owner\'s agents, and is the one path the file tools refuse, with its log in the state directory', () => {
    expect(launchdAgentPath('/Users/owner')).toBe('/Users/owner/Library/LaunchAgents/com.5straps.buckle.plist')
    expect(launchdGuardedPaths('/Users/owner')).toEqual(['/Users/owner/Library/LaunchAgents/com.5straps.buckle.plist'])
    expect(launchdLogPath('/Users/owner/.5straps/buckle')).toBe('/Users/owner/.5straps/buckle/logs/launchd.log')
  })
})
