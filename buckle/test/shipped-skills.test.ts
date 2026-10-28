import { describe, expect, it } from 'vitest'
import { createPathView } from '../common/domain/path-view.js'
import { createBuiltinPacks } from '../common/services/packs/index.js'
import { createFsPack } from '../common/services/packs/fs/index.js'
import { createWebPack } from '../common/services/packs/web/index.js'
import { loadPackSkill, loadRootSkill } from '../common/services/packs/pack-skill.js'
import { toolNameToCommand } from '../cli/arguments.js'
import { createNoneSandbox } from '../common/adapters/sandbox/none-sandbox.js'

/**
 * A shipped SKILL.md that names a command the CLI does not have sends an agent down a dead end, which is how
 * dev/SKILL.md came to show `buckle dev` and shell/SKILL.md `buckle shell script`. This renders every command line
 * each shipped skill prints and checks that each `buckle <group> <verb>` it names is a real tool in the CLI's command
 * table, so the skills cannot drift from the tools again.
 */

/** Every tool the built-in packs define, available here or not, as the group and verb the CLI dispatches it by. */
function toolCommands(): Set<string> {
  const packs = createBuiltinPacks({
    allowHostGit: true,
    allowHostLsp: true,
    enableShell: true,
    cwd: '/work/project',
    paths: createPathView({ root: '/work/project', mount: null }),
    hiddenPaths: [],
    mountReadOnlyPaths: [],
    approvedUrls: null,
    approvedLists: [],
    runProcess: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false }),
    sandbox: createNoneSandbox(),
    writableRoots: ['/work/project'],
    
    // A token so the forge pack builds its tools (git commit, git push, pr open, pr read); the names exist whether or
    // not this host can run them.
    forge: { token: 'fixture-token', apiUrl: 'https://api.github.com', author: { name: 'test', email: 'test@example.com' } },
    stateDirectory: '/state',
    agentBrowserCommand: 'agent-browser',
    browserStateDirectory: '/state/browser-profiles/project',
    browserHeaded: false,
    environmentValidator: 'validate',
    sandboxUnavailableReason: null,
  })
  const paths = createPathView({ root: '/work/project', mount: null })
  const runProcess = async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false })
  // fs search and web search are defined only with ripgrep and a search key, both host-gated; the skills document
  // them all the same, so the catalog names every tool each pack can define, not only the ones this host enables.
  const complete = [
    ...packs,
    createFsPack({ paths, runProcess, ripgrep: { path: 'rg', argv0: 'rg', args: [] }, protectedRoots: [] }),
    createWebPack({ braveSearchApiKey: 'fixture', approved: null }),
  ]
  const commands = new Set<string>()
  for (const pack of complete) {
    for (const tool of pack.tools) {
      const { group, verb } = toolNameToCommand(tool.capability.name)
      commands.add(verb ? `${group} ${verb}` : group)
    }
  }
  return commands
}

/** The commands that run no tool: the top-level verbs and the owner commands a skill may still name. */
const NON_TOOL_COMMANDS = new Set([
  'init', 'serve', 'mcp', 'tools', 'manifest', 'skills', 'call', 'approve', 'approvals', 'check-url', 'grants',
  'workspace', 'workspaces', 'history', 'log', 'plugin', 'policy', 'keys', 'settings', 'client', 'cp', 'help',
])

/** Every `buckle ...` line inside a fenced code block, its comment and flags dropped, as a word array after `buckle`. */
function commandLines(content: string): string[][] {
  const lines: string[][] = []
  let inFence = false
  for (const raw of content.split('\n')) {
    if (raw.startsWith('```')) { inFence = !inFence; continue }
    if (!inFence) continue
    const line = raw.replace(/#.*$/, '').trim()
    if (!line.startsWith('buckle ') && line !== 'buckle') continue
    lines.push(line.split(/\s+/).slice(1))
  }
  return lines
}

const skills = [
  { id: 'buckle', content: loadRootSkill().content },
  ...['fs', 'history', 'web', 'git', 'forge', 'dev', 'browser', 'shell'].map(pack => ({ id: pack, content: loadPackSkill(pack).content })),
]

describe('every shipped SKILL.md names real CLI commands', () => {
  const table = toolCommands()

  // The two defects that prompted this test must be gone: the dev and shell packs name their real command groups.
  it('dev names lsp and shell names script, the groups the CLI actually dispatches', () => {
    expect(loadPackSkill('dev').content).not.toMatch(/\bbuckle dev\b/)
    expect(loadPackSkill('dev').content).toMatch(/\bbuckle lsp\b/)
    expect(loadPackSkill('shell').content).not.toMatch(/\bbuckle shell script\b/)
    expect(loadPackSkill('shell').content).toMatch(/\bbuckle script run\b/)
  })

  it.each(skills)('$id: every buckle <group> <verb> it shows is a real tool or an owner command', ({ content }) => {
    const unknown: string[] = []
    for (const words of commandLines(content)) {
      const group = words[0]
      if (group === undefined || group.startsWith('-')) continue
      if (NON_TOOL_COMMANDS.has(group)) continue
      const verb = words[1]
      // A tool command is `<group> <verb>` unless the tool is a single word; a following word that is a flag, `--`, a
      // placeholder or a value is not the verb.
      const isVerb = verb !== undefined && /^[a-z][a-z-]*$/.test(verb)
      const command = isVerb ? `${group} ${verb}` : group
      if (!table.has(command) && !table.has(group)) unknown.push(`buckle ${words.join(' ')}`)
    }
    expect(unknown).toEqual([])
  })
})
