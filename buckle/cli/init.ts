import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { dirname, resolve } from 'pathe'
import { parseArgs } from 'node:util'
import { MountPathSchema } from '@5straps/protocol'
import { stateDirectoryOf, workspaceHolds } from '../common/runtime/config.js'
import { defaultEnvironmentFile, environmentFilePath } from '../common/runtime/environment.js'
import { AS_NAMED, findProgram, ON_PATH, rootsOf, type ProgramSearch, type UntrustedRoots } from '../common/domain/executable.js'
import { isDriveRoot, typedPath, WHOLE_DRIVE } from '../common/domain/paths.js'
import { BROWSER_INSTALL } from '../common/services/packs/browser/index.js'
import { BUILTIN_PACKS } from '../common/services/packs/index.js'
import { writeEnvironmentFile } from './environment-file.js'
import { findNodeSetting, normaliseSetting } from './node-settings.js'
import { redeemPairingCode } from './pairing.js'

export interface CliResult {
  exitCode: number
}

const USAGE = `Usage: buckle init [--root <dir>] [--mount <path>] [--name <name>] [--port <n>] [--out <file>] [--yes] [--force]
                  [--pair <code> --rings <url> [--url <public url>]]

Defaults: current directory as root, /workspace as mount, and the absolute root path with
path separators replaced by hyphens as the name.

Writes buckle.env in the state directory (~/.5straps/buckle, or BUCKLE_STATE_DIR), owner-only;
the working directory is never used. --out or BUCKLE_ENV_FILE selects a custom file instead.
Writes settings for one workspace, with a fresh agent token and a fresh admin
credential. Asks for the few decisions when run in a terminal: the workspace, which packs to
enable, the shell, host Git and the network lists. --yes, or no terminal, takes the defaults and
says what it kept. Change any of them later with buckle settings set.

With --pair, the node registers itself with Rings by redeeming a code issued there, so no
credential is typed from one screen into another. --url is where Rings reaches this node, and
defaults to http://127.0.0.1:<port>, which only serves a Rings on this host. Pairing again
beside an existing environment file keeps its credentials and updates the node's URL.
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
 * The node settings `buckle init` asks for after the workspace, each shown with the shipped
 * default. Enter keeps it: a default grants an agent nothing an unedited install would not.
 */
export interface NodeChoices {
  /** Null keeps every built-in pack and plugins; a list names the packs, which drops plugins. */
  packs: string[] | null
  shell: boolean
  hostGit: boolean
  networkAllow: string | null
  allowedHosts: string | null
}

const DEFAULT_CHOICES: NodeChoices = { packs: null, shell: true, hostGit: false, networkAllow: null, allowedHosts: null }

/**
 * `options.platform`: the host's unless a test imitates another; on Windows the hints are printed in each shell's form.
 * `options.programSearch`: where the programs section looks, the host's unless a test names its own.
 */
export async function runInit(argv: string[], prompt: InitPrompt = terminalPrompt(), options: { home?: string; platform?: NodeJS.Platform; programSearch?: ProgramSearch } = {}): Promise<CliResult> {
  const platform = options.platform ?? process.platform
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: 'string' },
      mount: { type: 'string' },
      name: { type: 'string' },
      port: { type: 'string' },
      out: { type: 'string' },
      pair: { type: 'string' },
      rings: { type: 'string' },
      url: { type: 'string' },
      yes: { type: 'boolean' },
      force: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  })
  if (values.help) {
    process.stdout.write(USAGE)
    return { exitCode: 0 }
  }

  if (values.pair && !values.rings) {
    process.stderr.write('--pair needs --rings <url>, the Rings that issued the code.\n')
    return { exitCode: 1 }
  }

  const out = values.out ? resolve(values.out) : environmentFilePath()
  // Pairing beside a configured node re-pairs it: the credentials stay, the URL is what moved.
  if (existsSync(out) && values.pair && !values.force) return pairExisting({ out, code: values.pair, rings: values.rings!, url: values.url, home: options.home, platform })
  if (existsSync(out) && !values.force) {
    process.stderr.write(`${out} already exists. Pass --force to replace it, or --out to write elsewhere.\n`)
    return { exitCode: 1 }
  }

  const interactive = prompt.interactive && !values.yes
  let answers: { root: string; mount: string | null; name: string | null }
  let choices = DEFAULT_CHOICES
  try {
    answers = interactive
      ? await askWorkspace(prompt, { root: values.root, mount: values.mount, name: values.name })
      : { root: values.root ?? process.cwd(), mount: values.mount ?? '/workspace', name: values.name ?? null }
    if (interactive) choices = await askNodeChoices(prompt)
  } finally {
    prompt.close()
  }

  const root = typedPath(answers.root, platform)
  if (isDriveRoot(root, platform)) {
    process.stderr.write(`The workspace root is ${root}: ${WHOLE_DRIVE}.\n`)
    return { exitCode: 1 }
  }
  // An agent writes anywhere in its workspace, so the workspace never holds the node's state and credentials.
  if (workspaceHolds(root, dirname(out)) || workspaceHolds(root, stateDirectoryOf(process.env, platform))) {
    process.stderr.write(`${root} holds the state directory or the environment file; choose a workspace root outside ${dirname(out)}.\n`)
    return { exitCode: 1 }
  }
  const mount = answers.mount?.trim() || null
  if (mount && !MountPathSchema.safeParse(mount).success) {
    process.stderr.write(`Invalid mount path: ${mount}. Use an absolute path with plain segments, e.g. /workspace\n`)
    return { exitCode: 1 }
  }
  const name = answers.name?.trim() || defaultNodeName(root)
  const port = values.port ?? '4320'
  if (!/^\d+$/.test(port)) {
    process.stderr.write(`Invalid port: ${port}\n`)
    return { exitCode: 1 }
  }

  const authToken = token()
  const adminToken = token()
  const contents = renderEnv({ root, mount, name, port, authToken, adminToken, choices })
  // The state directory holds the node's credentials, so it is created owner-only (ruling 7).
  if (out === defaultEnvironmentFile()) mkdirSync(dirname(out), { recursive: true, mode: 0o700 })
  writeEnvironmentFile(out, contents)

  process.stdout.write(`Wrote ${out}

  Workspace   ${root}
  Seen as     ${mount ?? root}
  Name        ${name}
${describeChoices(choices)}${interactive ? '' : 'These are the defaults, kept because nothing was asked. Change one with: buckle settings set <key> <value>\n'}
${describePrograms({ root, platform, search: options.programSearch ?? {} })}

Next:
${hintStep('  1. Start the node:', serveCommand(out, process.env, platform))}
  2. Register it in Rings with both credentials, or drive it directly:
       agent token        ${authToken}
       admin credential   ${adminToken}
${hintStep('  3. Restrict it:', restrictCommands(platform))}

The agent token runs tools. The admin credential reads and pushes the policy at /setup, mints
and revokes workspace tokens, and nothing else. Keep them apart; Buckle refuses to start if
they are the same value. /setup is experimental and off until you switch it on:
buckle settings set experimental-admin-http on
`)

  if (!values.pair) return { exitCode: 0 }
  return pair({ out, contents, code: values.pair, rings: values.rings!, url: values.url, port, home: options.home, platform })
}

/** Re-pairs a node that already has an environment file, keeping the credentials it holds. */
async function pairExisting(input: { out: string; code: string; rings: string; url?: string; home?: string; platform: NodeJS.Platform }): Promise<CliResult> {
  const contents = readFileSync(input.out, 'utf8')
  const port = /^BUCKLE_PORT=(\d+)$/m.exec(contents)?.[1] ?? '4320'
  process.stdout.write(`Pairing the node configured in ${input.out}; its credentials are unchanged.\n`)
  return pair({ ...input, contents, port })
}

async function pair(input: { out: string; contents: string; code: string; rings: string; url?: string; port: string; home?: string; platform: NodeJS.Platform }): Promise<CliResult> {
  const baseUrl = input.url?.trim() || `http://127.0.0.1:${input.port}`
  const result = await redeemPairingCode({ code: input.code, ringsUrl: input.rings, baseUrl, environmentFile: input.out, environmentText: input.contents, ...(input.home ? { home: input.home } : {}) })
  process.stdout.write(`\n${result.message}\n`)
  if (result.ok) process.stdout.write(`Rings will reach it at ${baseUrl}. ${hintStep('Start it with:', serveCommand(input.out, process.env, input.platform), { column: 'Start it with: '.length, indent: '  ' })}\n`)
  return { exitCode: result.ok ? 0 : 1 }
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

async function askWorkspace(prompt: InitPrompt, defaults: { root?: string; mount?: string; name?: string }) {
  const root = (await prompt.question(`Workspace root [${defaults.root ?? process.cwd()}]: `)).trim() || defaults.root || process.cwd()
  const mountAnswer = (await prompt.question(`Virtual workspace path [${defaults.mount ?? '/workspace'}]: `)).trim()
  const mount = mountAnswer || defaults.mount || '/workspace'
  const name = (await prompt.question(`Name for this node [${defaults.name ?? defaultNodeName(resolve(root))}]: `)).trim() || defaults.name || null
  return { root, mount, name }
}

async function askNodeChoices(prompt: InitPrompt): Promise<NodeChoices> {
  prompt.say('\nPacks this node offers:')
  for (const pack of BUILTIN_PACKS) prompt.say(`  ${pack.id.padEnd(12)} ${pack.summary}`)
  const packs = await askValid(prompt, 'Packs to enable, comma separated; naming them turns plugins off [all]: ', 'BUCKLE_PACKS')
  const shell = await askYesNo(prompt, 'Shell tools on? [Y/n]: ', true)
  prompt.say('Host Git and forge tools read the repository outside the sandbox\'s per-file checks, so they start off.')
  const hostGit = await askYesNo(prompt, 'Host Git and forge tools on? [y/N]: ', false)
  const networkAllow = await askValid(prompt, 'Approved hosts and URLs, the only ones fetches and pages may reach, e.g. localhost:3000,*.example.com [none]: ', 'BUCKLE_NETWORK_ALLOW')
  const allowedHosts = await askValid(prompt, 'Private-address hosts web_fetch may reach, e.g. db.internal,*.internal.test [none]: ', 'BUCKLE_ALLOWED_HOSTS')
  return { packs: packs === null ? null : packs.split(','), shell, hostGit, networkAllow, allowedHosts }
}

/** Asks until the answer passes the same check `buckle settings set` applies; empty keeps the default. */
async function askValid(prompt: InitPrompt, text: string, key: string): Promise<string | null> {
  const setting = findNodeSetting(key)!
  for (;;) {
    const answer = (await prompt.question(text)).trim()
    if (!answer) return null
    const value = normaliseSetting({ setting, raw: answer, cwd: process.cwd(), isDirectory: () => false, environment: process.env })
    if (value.ok) return value.value
    prompt.say(value.reason)
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

function describeChoices(choices: NodeChoices): string {
  return `  Packs       ${choices.packs?.join(', ') ?? 'all, and plugins'}
  Shell       ${choices.shell ? 'on' : 'off'}
  Host Git    ${choices.hostGit ? 'on' : 'off'}
  Network     ${choices.networkAllow ?? 'no approved list'}; private hosts ${choices.allowedHosts ?? 'none'}
`
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
 * The programs Buckle runs, checked as a pack resolves each (findProgram) against the workspace just chosen: a line
 * each, saying where it was found and how it runs, or why not and what it unlocks (program detection brief,
 * 2026-10-14). Unlike a pack's reason, which an agent may read, this prints the paths: it is the owner's terminal.
 */
function describePrograms(input: { root: string; platform: NodeJS.Platform; search: ProgramSearch }): string {
  const programs: CheckedProgram[] = [
    ...(input.platform === 'linux' ? [{ label: 'bwrap', name: 'bwrap', unlocks: 'the sandboxed shell pack' }] : []),
    { label: 'rg', name: 'rg', unlocks: 'the fs_search_content tool' },
    { label: 'git', name: 'git', unlocks: 'the git and forge packs, once host Git is turned on' },
    { label: 'agent-browser', name: process.env.BUCKLE_AGENT_BROWSER_COMMAND || 'agent-browser', unlocks: 'the browser pack', install: BROWSER_INSTALL, setting: 'BUCKLE_AGENT_BROWSER_COMMAND' },
  ]
  const search = { ...input.search, platform: input.platform, untrustedRoots: rootsOf('workspace', [input.root]) }
  const lines = programs.map(program => `  ${program.label.padEnd(15)} ${programLine(program, search)}`)
  return `Programs\n${lines.join('\n')}`
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

/** Only an answer that moved off the default adds a line; the rest stay as commented placeholders. */
function renderChoices(choices: NodeChoices): string {
  return `${choices.packs ? `BUCKLE_PACKS=${choices.packs.join(',')}` : '# BUCKLE_PACKS=fs,web,shell'}
BUCKLE_ALLOW_SHELL=${choices.shell}
# Host Git and forge tools read the repository outside per-file checks.
${choices.hostGit ? 'BUCKLE_ALLOW_HOST_GIT=true' : '# BUCKLE_ALLOW_HOST_GIT=true'}`
}

function renderEnv(input: { root: string; mount: string | null; name: string; port: string; authToken: string; adminToken: string; choices: NodeChoices }): string {
  return `# Written by buckle init on ${new Date().toISOString()}
# buckle serve reads buckle.env in its state directory; a file anywhere else is named with BUCKLE_ENV_FILE.

BUCKLE_SERVER_ID=${slug(input.name)}
BUCKLE_SERVER_NAME=${input.name}
BUCKLE_HOST=127.0.0.1
BUCKLE_PORT=${input.port}

# What agents call tools with. Rings stores this one.
BUCKLE_AUTH_TOKEN=${input.authToken}
# What configures the node through /setup, mints workspace tokens and writes a persisted
# approval. Rings stores this one too, apart from the first. /setup is experimental and served
# only with BUCKLE_EXPERIMENTAL_ADMIN_HTTP=true (buckle settings set experimental-admin-http on).
BUCKLE_ADMIN_TOKEN=${input.adminToken}

BUCKLE_WORKSPACE_ROOT=${input.root}
# The state directory is where this file lives by default; move it with BUCKLE_STATE_DIR in the shell.
# BUCKLE_STATE_DIR=
${input.mount ? `BUCKLE_WORKSPACE_MOUNT=${input.mount}` : '# BUCKLE_WORKSPACE_MOUNT=/workspace'}
BUCKLE_SANDBOX=auto
# Milliseconds a call waits for approval when its caller sends no wait of its own: 60000 = one
# minute; 0 = until someone answers. Rings sends its own wait with each call, which overrides this.
# Restart serve after changing this.
# BUCKLE_APPROVAL_TIMEOUT_MS=15000
${renderChoices(input.choices)}

# The owner's constraints, as shell-word globs. One pattern per line inside double quotes, or
# separated by ;;  An allow glob covers the whole line, a deny glob everything starting with it.
# BUCKLE_COMMAND_ALLOW="docker compose {up,down,restart} *;;pnpm {build,test} *"
# BUCKLE_COMMAND_DENY="{sh,bash,node,python,python3,curl,wget}"
# Commands that ask first, added to the built-in destructive list, which nothing removes.
# BUCKLE_COMMAND_DESTRUCTIVE="terraform destroy *"
${input.choices.networkAllow ? `BUCKLE_NETWORK_ALLOW=${input.choices.networkAllow}` : '# BUCKLE_NETWORK_ALLOW=localhost:3000,*.example.com'}
${input.choices.allowedHosts ? `BUCKLE_ALLOWED_HOSTS=${input.choices.allowedHosts}` : '# BUCKLE_ALLOWED_HOSTS=db.internal'}

# Where this node reports what it did, and where a request waiting for a decision is announced.
# buckle init --pair fills all three in from Rings, with the report credential Rings mints for
# this node; Rings refuses a report filed for a node that credential does not belong to.
# BUCKLE_REPORT_URL=
# BUCKLE_REPORT_TOKEN=
# BUCKLE_APPROVAL_WEBHOOK=
`
}

function token(): string {
  return randomBytes(24).toString('base64url')
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'buckle'
}

function defaultNodeName(root: string): string {
  return root.replace(/[\\/]/g, '-')
}
