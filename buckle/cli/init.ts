import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { dirname, resolve } from 'pathe'
import { parseArgs } from 'node:util'
import { MountPathSchema, type HarnessManifest } from '@5straps/protocol'
import { loadConfig, realPathOf, stateDirectoryOf, workspaceHolds, type NodeConfig } from '../common/runtime/config.js'
import { buckleVariables, defaultEnvironmentFile, environmentFilePath } from '../common/runtime/environment.js'
import { AS_NAMED, findProgram, ON_PATH, type ProgramSearch, type UntrustedRoots } from '../common/domain/executable.js'
import { isDriveRoot, typedPath, WHOLE_DRIVE } from '../common/domain/paths.js'
import { refusedNetworkEntries } from '../common/domain/policy.js'
import { BROWSER_INSTALL } from '../common/services/packs/browser/index.js'
import { BUILTIN_PACKS, unmetPackPrerequisite } from '../common/services/packs/index.js'
import { nodeRootsOf, openWorkspaceManager, WorkspaceError, type MintedToken, type WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import { MigrationError } from '../common/services/workspaces/migration.js'
import { workspaceUntrusted } from '../common/services/workspaces/node-roots.js'
import type { WorkspaceSettings } from '../common/services/workspaces/workspace-settings.js'
import { writeEnvironmentFile } from './environment-file.js'
import { findNodeSetting, normaliseSetting } from './node-settings.js'
import { redeemPairingCode } from './pairing.js'

export interface CliResult {
  exitCode: number
}

const USAGE = `Usage: buckle init [--dir <dir>] [--mount <path>] [--name <name>] [--port <n>] [--out <file>] [--yes] [--force]
                  [--pair <code> --rings <url> [--url <public url>]]

Sets this machine's node up once, then serves a folder as one of its workspaces: the current directory, or --dir
(--root is its earlier name), seen by the agent at /workspace, or at --mount. --name names the node.

The node's settings go to buckle.env in the state directory (~/.5straps/buckle, or BUCKLE_STATE_DIR), owner-only;
--out or BUCKLE_ENV_FILE selects a custom file instead. They hold its name, host, port and admin credential, and a
node already set up keeps them unless --force writes them again. The workspace's own settings go to its
workspace.json. In a terminal, init asks for the folder, which packs to offer, the shell, host Git and the approved
hosts; --yes, or no terminal, takes the defaults and says what it kept. Change them later with buckle workspace set
and buckle policy. The workspace's agent token is printed once; buckle workspace token create mints more.

With --pair, the node registers itself with Rings by redeeming a code issued there, with the workspace's token, so no
credential is typed from one screen into another. --url is where Rings reaches this node, and defaults to
http://127.0.0.1:<port>, which only serves a Rings on this host. Pairing again keeps the node's settings, mints the
workspace a token for Rings, and updates the node's URL.
`

/** Where the questions are asked. A terminal by default; a test hands in scripted answers. */
export interface InitPrompt {
  interactive: boolean
  question(text: string): Promise<string>
  /** Explanations beside a question, on the same stream the questions use. */
  say(text: string): void
  close(): void
}

/**
 * The workspace's settings `buckle init` asks for after its folder, each shown with the shipped default. Enter keeps
 * it: a default grants an agent nothing an unedited install would not.
 */
export interface WorkspaceChoices {
  /** Null offers every built-in pack and plugins; a list names the packs, which drops plugins. */
  packs: string[] | null
  shell: boolean
  hostGit: boolean
  networkAllow: string[] | null
}

const DEFAULT_CHOICES: WorkspaceChoices = { packs: null, shell: true, hostGit: false, networkAllow: null }

/**
 * `buckle init` (D83 (2)): the node, when this machine has none yet, then the folder as a workspace of it.
 * `options.platform`: the host's unless a test imitates another; on Windows the hints are printed in each shell's form.
 * `options.programSearch`: where the programs section looks, the host's unless a test names its own.
 */
export async function runInit(argv: string[], prompt: InitPrompt = terminalPrompt(), options: { home?: string; platform?: NodeJS.Platform; programSearch?: ProgramSearch } = {}): Promise<CliResult> {
  const platform = options.platform ?? process.platform
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: 'string' }, root: { type: 'string' }, mount: { type: 'string' }, name: { type: 'string' }, port: { type: 'string' }, out: { type: 'string' },
      pair: { type: 'string' }, rings: { type: 'string' }, url: { type: 'string' }, yes: { type: 'boolean' }, force: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  })
  if (values.help) {
    process.stdout.write(USAGE)
    return { exitCode: 0 }
  }
  if (values.pair && !values.rings) return fail('--pair needs --rings <url>, the Rings that issued the code.')

  const out = values.out ? resolve(values.out) : environmentFilePath()
  const writesNode = !existsSync(out) || values.force === true
  const interactive = prompt.interactive && !values.yes
  const given = values.dir ?? values.root
  let answers: { folder: string; mount: string | null; name: string | null; allowedHosts: string | null }
  let choices = DEFAULT_CHOICES
  try {
    answers = interactive
      ? await askFolder(prompt, { folder: given, mount: values.mount, name: values.name, writesNode })
      : { folder: given ?? process.cwd(), mount: values.mount ?? '/workspace', name: values.name ?? null, allowedHosts: null }
    if (interactive) {
      choices = await askWorkspaceChoices(prompt)
      if (writesNode) answers.allowedHosts = await askValid(prompt, 'Private-address hosts web_fetch may reach, e.g. db.internal,*.internal.test [none]: ', raw => nodeSettingValue('BUCKLE_ALLOWED_HOSTS', raw))
    }
  } finally {
    prompt.close()
  }

  const folder = typedPath(answers.folder, platform)
  if (isDriveRoot(folder, platform)) return fail(`The workspace folder is ${folder}: ${WHOLE_DRIVE}.`)
  // An agent writes anywhere in its workspace, so the workspace never holds the node's state and credentials.
  if (workspaceHolds(folder, dirname(out)) || workspaceHolds(folder, stateDirectoryOf(process.env, platform))) return fail(`${folder} holds the state directory or the environment file; choose a folder outside ${dirname(out)}.`)
  const mount = answers.mount?.trim() || null
  if (mount && !MountPathSchema.safeParse(mount).success) return fail(`Invalid mount path: ${mount}. Use an absolute path with plain segments, e.g. /workspace`)
  const port = values.port ?? '4320'
  if (!/^\d+$/.test(port)) return fail(`Invalid port: ${port}`)

  const name = answers.name?.trim() || defaultNodeName(folder)
  const adminToken = writesNode ? credential() : null
  if (adminToken) {
    // The state directory holds the node's credentials, so it is created owner-only (ruling 7).
    if (out === defaultEnvironmentFile()) mkdirSync(dirname(out), { recursive: true, mode: 0o700 })
    writeEnvironmentFile(out, renderNode({ name, port, adminToken, allowedHosts: answers.allowedHosts }))
  }
  const contents = readFileSync(out, 'utf8')
  const node = nodeConfig(out, contents, platform)
  mkdirSync(node.stateDirectory, { recursive: true, mode: 0o700 })
  let workspaces: WorkspaceManager
  try { workspaces = await openWorkspaceManager({ config: node, platform }) } catch (error) {
    if (error instanceof WorkspaceError || error instanceof MigrationError) return fail(error.message)
    throw error
  }
  try {
    const served = await serveFolder({ workspaces, folder, mount, choices })
    const nodePort = /^BUCKLE_PORT=(\d+)$/m.exec(contents)?.[1] ?? port
    process.stdout.write(`${adminToken ? `Wrote ${out}` : `The node is already set up in ${out}; its settings are unchanged.`}
${served.token ? '' : `\n${folder} is already in workspace ${served.id}: nothing was added. Mint a token for it with buckle workspace token create --workspace ${served.id}.\n`}
  Workspace   ${served.id} at ${folder}
  Seen as     ${served.created ? (mount ?? folder) : '(as it was)'}
${adminToken ? `  Node name   ${name}\n` : ''}${served.created ? describeChoices(choices) : ''}${served.created && !interactive ? 'These are the defaults, kept because nothing was asked. Change one with: buckle workspace set <key> <value>\n' : ''}
${describePrograms({ node, folder, platform, search: options.programSearch ?? {} })}

Next:
${hintStep('  1. Start the node:', serveCommand(out, process.env, platform))}
${served.token ? `  2. Give an agent this workspace's token, shown once; it reaches /mcp and /v1 at http://127.0.0.1:${nodePort}:
       agent token        ${served.token.token}
` : ''}${adminToken ? `     The node's admin credential, for Rings and the experimental /setup face:
       admin credential   ${adminToken}
` : ''}${hintStep('  3. Restrict it:', restrictCommands(platform))}

The agent token runs tools in this workspace alone. The admin credential reads and pushes a workspace's policy at
/setup, mints and revokes workspace tokens, and nothing else; keep them apart. /setup is experimental and off until you
switch it on: buckle settings set experimental-admin-http on
`)
    if (!values.pair) return { exitCode: 0 }
    const token = served.token ?? await workspaces.addToken(served.id, { label: 'Rings' })
    const { runtime } = await workspaces.resolve(served.id)
    return await pair({ out, code: values.pair, rings: values.rings!, url: values.url, port: nodePort, home: options.home, platform, authToken: token.token, adminToken: node.adminToken, manifest: runtime.manifest(), name: node.serverName })
  } catch (error) {
    if (error instanceof WorkspaceError) return fail(error.message)
    throw error
  } finally {
    await workspaces.close()
  }
}

/** The folder as a workspace: a new one with the choices as its settings, or the one already holding it, which keeps its own. */
async function serveFolder(input: { workspaces: WorkspaceManager; folder: string; mount: string | null; choices: WorkspaceChoices }): Promise<{ id: string; created: boolean; token: MintedToken | null }> {
  let holder: string | null = null
  try { holder = input.workspaces.target({ cwd: input.folder }) } catch (error) {
    if (!(error instanceof WorkspaceError)) throw error
  }
  if (holder !== null) return { id: holder, created: false, token: null }
  const { workspace, token } = await input.workspaces.create({ dir: input.folder, label: 'buckle init', settings: settings => withChoices(settings, input.choices, input.mount) })
  return { id: workspace.id, created: true, token }
}

function withChoices(settings: WorkspaceSettings, choices: WorkspaceChoices, mount: string | null): WorkspaceSettings {
  return {
    ...settings,
    packs: { ...settings.packs, enabled: choices.packs, shell: choices.shell, hostGit: choices.hostGit },
    policy: { ...settings.policy, network: { allow: choices.networkAllow ?? [] } },
    mounts: mount === null ? [] : [{ kind: 'workspace', target: mount, access: 'write' }],
  }
}

/** Re-pairs or pairs the node, sending the workspace's token and its manifest (BUCKLE-D08). */
async function pair(input: { out: string; code: string; rings: string; url?: string; port: string; home?: string; platform: NodeJS.Platform; authToken: string; adminToken: string; manifest: HarnessManifest; name: string }): Promise<CliResult> {
  const baseUrl = input.url?.trim() || `http://127.0.0.1:${input.port}`
  const result = await redeemPairingCode({ code: input.code, ringsUrl: input.rings, baseUrl, environmentFile: input.out, authToken: input.authToken, adminToken: input.adminToken, manifest: input.manifest, name: input.name, ...(input.home ? { home: input.home } : {}) })
  process.stdout.write(`\n${result.message}\n`)
  if (result.ok) process.stdout.write(`Rings will reach it at ${baseUrl}. ${hintStep('Start it with:', serveCommand(input.out, process.env, input.platform), { column: 'Start it with: '.length, indent: '  ' })}\n`)
  return { exitCode: result.ok ? 0 : 1 }
}

async function askFolder(prompt: InitPrompt, defaults: { folder?: string; mount?: string; name?: string; writesNode: boolean }) {
  const folder = (await prompt.question(`Folder to serve [${defaults.folder ?? process.cwd()}]: `)).trim() || defaults.folder || process.cwd()
  const mount = (await prompt.question(`Where the agent sees it [${defaults.mount ?? '/workspace'}]: `)).trim() || defaults.mount || '/workspace'
  const name = defaults.writesNode ? (await prompt.question(`Name for this node [${defaults.name ?? defaultNodeName(resolve(folder))}]: `)).trim() || defaults.name || null : null
  return { folder, mount, name, allowedHosts: null as string | null }
}

async function askWorkspaceChoices(prompt: InitPrompt): Promise<WorkspaceChoices> {
  prompt.say('\nPacks this workspace offers:')
  for (const pack of BUILTIN_PACKS) prompt.say(`  ${pack.id.padEnd(12)} ${pack.summary}`)
  const packs = await askValid(prompt, 'Packs to offer, comma separated; naming them turns plugins off [all]: ', packList)
  const shell = await askYesNo(prompt, 'Shell tools on? [Y/n]: ', true)
  prompt.say('Host Git and forge tools read the repository outside the sandbox\'s per-file checks, so they start off.')
  const hostGit = await askYesNo(prompt, 'Host Git and forge tools on? [y/N]: ', false)
  const networkAllow = await askValid(prompt, 'Approved hosts and URLs, the only ones fetches and pages may reach, e.g. localhost:3000,*.example.com [none]: ', urlList)
  return { packs: packs === null ? null : packs.split(','), shell, hostGit, networkAllow: networkAllow === null ? null : networkAllow.split(',') }
}

/** The packs named, each one Buckle has and this node can build, as the workspace's packs.enabled will hold them. */
function packList(raw: string): { ok: true; value: string } | { ok: false; reason: string } {
  const ids = [...new Set(raw.split(',').map(item => item.trim()).filter(Boolean))]
  const unknown = ids.filter(id => !BUILTIN_PACKS.some(pack => pack.id === id))
  if (unknown.length) return { ok: false, reason: `Unknown pack ${unknown.join(', ')}. Packs: ${BUILTIN_PACKS.map(pack => pack.id).join(', ')}` }
  const unmet = ids.flatMap(id => { const reason = unmetPackPrerequisite(id, { environmentValidator: process.env.BUCKLE_ENV_VALIDATOR_COMMAND || undefined }); return reason ? [`${id} (${reason})`] : [] })
  if (unmet.length) return { ok: false, reason: `The node would not build pack ${unmet.join(', ')}. Set the prerequisite first, or leave the pack out` }
  return { ok: true, value: ids.join(',') }
}

/** Entries the URL grammar takes, as the workspace's approved list will hold them. */
function urlList(raw: string): { ok: true; value: string } | { ok: false; reason: string } {
  const entries = [...new Set(raw.split(',').map(item => item.trim()).filter(Boolean))]
  const refused = refusedNetworkEntries(entries)
  if (refused.length) return { ok: false, reason: `Invalid approved list entry ${refused[0]!.entry}: ${refused[0]!.reason}` }
  return { ok: true, value: entries.join(',') }
}

function nodeSettingValue(key: string, raw: string): { ok: true; value: string } | { ok: false; reason: string } {
  return normaliseSetting({ setting: findNodeSetting(key)!, raw, cwd: process.cwd(), isDirectory: () => false })
}

/** Asks until the answer passes `check`; empty keeps the default. */
async function askValid(prompt: InitPrompt, text: string, check: (raw: string) => { ok: true; value: string } | { ok: false; reason: string }): Promise<string | null> {
  for (;;) {
    const answer = (await prompt.question(text)).trim()
    if (!answer) return null
    const value = check(answer)
    if (value.ok) return value.value
    prompt.say(value.reason)
  }
}

function describeChoices(choices: WorkspaceChoices): string {
  return `  Packs       ${choices.packs?.join(', ') ?? 'all, and plugins'}
  Shell       ${choices.shell ? 'on' : 'off'}
  Host Git    ${choices.hostGit ? 'on' : 'off'}
  Network     ${choices.networkAllow?.join(',') ?? 'no approved list'}
`
}

/** The node's settings alone (Q3): each workspace's are in its workspace.json. */
function renderNode(input: { name: string; port: string; adminToken: string; allowedHosts: string | null }): string {
  return `# Written by buckle init on ${new Date().toISOString()}
# buckle serve reads buckle.env in its state directory; a file anywhere else is named with BUCKLE_ENV_FILE.
# The node's own settings, which every workspace on it shares. Each workspace's settings are in its workspace.json:
# buckle workspace show prints them, and buckle workspace set and buckle policy change them.

BUCKLE_SERVER_ID=${slug(input.name)}
BUCKLE_SERVER_NAME=${input.name}
BUCKLE_HOST=127.0.0.1
BUCKLE_PORT=${input.port}

# What configures the node through /setup, mints workspace tokens and writes a persisted approval: the one admin
# credential, every workspace's. Rings stores it at pairing. /setup is experimental and served only with
# BUCKLE_EXPERIMENTAL_ADMIN_HTTP=true (buckle settings set experimental-admin-http on).
BUCKLE_ADMIN_TOKEN=${input.adminToken}

# The state directory is where this file lives by default; move it with BUCKLE_STATE_DIR in the shell.
# BUCKLE_STATE_DIR=
BUCKLE_SANDBOX=auto
${input.allowedHosts ? `BUCKLE_ALLOWED_HOSTS=${input.allowedHosts}` : '# BUCKLE_ALLOWED_HOSTS=db.internal'}

# Where this node reports what it did, and where a request waiting for a decision is announced.
# buckle init --pair fills all three in from Rings, with the report credential Rings mints for
# this node; Rings refuses a report filed for a node that credential does not belong to.
# BUCKLE_REPORT_URL=
# BUCKLE_REPORT_TOKEN=
# BUCKLE_APPROVAL_WEBHOOK=
`
}

/** A hint's command lines as one shell reads them; `shell` names it where the platform has more than one. */
export interface ShellForm { shell: string | null; lines: string[] }

/**
 * How `buckle serve` finds the file just written: on its own from the default state directory, with
 * the state directory named when BUCKLE_STATE_DIR moved it, and by name for any other file. The
 * variable is set as the platform's shell sets one: before the command on Linux and macOS, and on
 * Windows in PowerShell's form and in cmd's, each its own; cmd's is quoted whole, or the space before
 * `&&` would end the value.
 */
export function serveCommand(out: string, environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ShellForm[] {
  const setting = out !== defaultEnvironmentFile(environment) ? { name: 'BUCKLE_ENV_FILE', value: out }
    : environment.BUCKLE_STATE_DIR ? { name: 'BUCKLE_STATE_DIR', value: dirname(out) } : null
  if (!setting) return [{ shell: null, lines: ['buckle serve'] }]
  const { name, value } = setting
  if (platform !== 'win32') return [{ shell: null, lines: [`${name}=${value} buckle serve`] }]
  return [
    { shell: 'PowerShell', lines: [`$env:${name} = '${value.replaceAll("'", "''")}'; buckle serve`] },
    { shell: 'cmd', lines: [`set "${name}=${value}" && buckle serve`] },
  ]
}

/** The example rules, quoted as each shell reads a quoted word: cmd keeps single quotes as part of the word. */
export function restrictCommands(platform: NodeJS.Platform = process.platform): ShellForm[] {
  const rules = (quote: string) => [`buckle policy allow-command ${quote}pnpm {build,test} *${quote}`, 'buckle policy allow-url localhost:3000']
  if (platform !== 'win32') return [{ shell: null, lines: rules("'") }]
  return [{ shell: 'PowerShell', lines: rules("'") }, { shell: 'cmd', lines: rules('"') }]
}

/** Where the hints' commands start, after the widest step label, as `buckle init` has always aligned them. */
const HINT_COLUMN = 32
const SHELL_LABEL_WIDTH = 13

/**
 * A hint: one form follows its label on the same line, its further lines aligned beneath; several forms each go
 * on lines of their own below the label, each labelled with its shell.
 */
function hintStep(label: string, forms: ShellForm[], layout: { column: number; indent: string } = { column: HINT_COLUMN, indent: '       ' }): string {
  const [only] = forms
  if (forms.length === 1 && only!.shell === null) return `${label.padEnd(layout.column)}${only!.lines.join(`\n${' '.repeat(layout.column)}`)}`
  const labelled = forms.flatMap(form => form.lines.map((line, index) => `${layout.indent}${(index === 0 ? form.shell ?? '' : '').padEnd(SHELL_LABEL_WIDTH)}${line}`))
  return [label, ...labelled].join('\n')
}

/** Questions on stderr, so stdout stays the summary; the readline is opened only when one is asked. */
function terminalPrompt(): InitPrompt {
  let readline: ReturnType<typeof createInterface> | null = null
  return {
    interactive: Boolean(process.stdin.isTTY),
    question: text => (readline ??= createInterface({ input: process.stdin, output: process.stderr })).question(text),
    say: text => void process.stderr.write(`${text}\n`),
    close: () => readline?.close(),
  }
}

async function askYesNo(prompt: InitPrompt, text: string, fallback: boolean): Promise<boolean> {
  for (;;) {
    const answer = (await prompt.question(text)).trim().toLowerCase()
    if (!answer) return fallback
    if (['y', 'yes', 'on', 'true'].includes(answer)) return true
    if (['n', 'no', 'off', 'false'].includes(answer)) return false
    prompt.say('Answer y or n, or press Enter for the default.')
  }
}

/** A program `buckle init` checks, by the name it is looked up by, with what it unlocks as docs/install.md words it. */
interface CheckedProgram {
  label: string
  name: string
  unlocks: string
  /** Where a program that is not found comes from, and the setting that names one it cannot run. */
  install?: string
  setting?: string
}

/**
 * The programs Buckle runs, each resolved as the node that reads the file just written resolves it (findProgram): its
 * configuration, read as serve reads it, and the roots it refuses programs in, the workspace's real root, its scratch
 * roots, and every root the node knows (workspaceUntrusted). A line each says where the program was found and how it
 * runs, or why the node will not run it, or what it unlocks (program detection brief and review, 2026-10-14). Unlike a
 * pack's reason, which an agent may read, this prints the paths: it is the owner's terminal.
 */
function describePrograms(input: { node: NodeConfig; folder: string; platform: NodeJS.Platform; search: ProgramSearch }): string {
  const config = input.node
  const programs: CheckedProgram[] = [
    ...(input.platform === 'linux' ? [{ label: 'bwrap', name: 'bwrap', unlocks: 'the sandboxed shell pack' }] : []),
    { label: 'rg', name: 'rg', unlocks: 'the fs_search_content tool' },
    { label: 'git', name: 'git', unlocks: 'the git and forge packs, once host Git is turned on' },
    { label: 'agent-browser', name: config.agentBrowserCommand, unlocks: 'the browser pack', install: BROWSER_INSTALL, setting: 'BUCKLE_AGENT_BROWSER_COMMAND' },
  ]
  const search = { ...input.search, platform: input.platform, ...workspaceUntrusted({ root: realPathOf(input.folder, input.platform), scratchRoots: config.scratchRoots }, nodeRootsOf(config, input.platform)) }
  const lines = programs.map(program => `  ${program.label.padEnd(15)} ${programLine(program, search)}`)
  return `Programs\n${lines.join('\n')}`
}

/**
 * The node as serve reads the file: its BUCKLE_ settings, each under a variable the shell sets (loadEnvironmentFile),
 * with the file's own values kept apart for migration (MigrationInput).
 */
function nodeConfig(file: string, contents: string, platform: NodeJS.Platform): NodeConfig {
  const values = Object.freeze(Object.fromEntries(buckleVariables(contents)))
  return loadConfig({ ...values, ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) }, platform, { file: { path: file, values }, caller: process.env })
}

/** One program's line: the path it runs, or the path of what was found and why it is not run, or where it was looked for. */
function programLine(program: CheckedProgram, search: ProgramSearch & UntrustedRoots & { platform: NodeJS.Platform }): string {
  const { resolved, found } = findProgram(program.name, search)
  const shown = (path: string) => search.platform === 'win32' ? path.replaceAll('/', '\\') : path
  if (resolved.path !== null) {
    const place = found === null || found.place === ON_PATH || found.place === AS_NAMED ? '' : ` (${found.place})`
    const runs = resolved.args.length > 0 ? ', a script run with Buckle\'s Node' : found?.shim ? ', through a shim' : ''
    return `found at ${shown(resolved.args[0] ?? resolved.path)}${place}${runs}`
  }
  const unlocks = `it unlocks ${program.unlocks}${program.install ? `; ${program.install}` : ''}`
  if (found === null) return `not found ${resolved.searched ?? `at ${shown(program.name)}`}; ${unlocks}`
  if (resolved.shim) return `found ${shown(found.path)}, ${resolved.shim.why}${program.setting ? `; set ${program.setting} to the ${program.label} .exe or script inside its package` : ''}`
  return `found at ${shown(found.path)}, not run: ${resolved.reason}`
}

function credential(): string {
  return randomBytes(24).toString('base64url')
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'buckle'
}

function defaultNodeName(root: string): string {
  return root.replace(/[\\/]/g, '-')
}

function fail(message: string): CliResult {
  process.stderr.write(`${message}\n`)
  return { exitCode: 1 }
}
