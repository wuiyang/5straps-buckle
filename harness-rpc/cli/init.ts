import { findWorkspaceConfig, registerWorkspaceConfig } from '../common/runtime/workspace-config.js'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { MountPathSchema } from '@5straps/protocol'
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

Writes ~/.5straps/workspaces/<id>/buckle.env and registers the root in map.json.
--out or BUCKLE_ENV_FILE selects a custom file instead.
Writes settings for one workspace, with a fresh agent token and a fresh admin
credential. Asks for the few decisions when run in a terminal: the workspace, which packs to
enable, the shell, host Git and the network lists. --yes, or no terminal, takes the defaults and
says what it kept. Change any of them later with buckle settings set.

With --pair, the node registers itself with Rings by redeeming a code issued there, so no
credential is typed from one screen into another. --url is where Rings reaches this node, and
defaults to http://127.0.0.1:<port>, which only serves a Rings on this host. Pairing again
beside an existing environment file keeps its credentials and updates the node's URL.
`

/**
 * Onboards a workspace: one file the node starts from, two credentials that never meet. The
 * agent token is what a harness or Rings calls tools with; the admin credential is what Rings
 * configures the node with, and no tool call can present it.
 */
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

export async function runInit(argv: string[], prompt: InitPrompt = terminalPrompt(), options: { home?: string } = {}): Promise<CliResult> {
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

  const explicitOut = values.out ?? process.env.BUCKLE_ENV_FILE
  let out = explicitOut ? resolve(explicitOut) : findWorkspaceConfig({ cwd: resolve(values.root ?? process.cwd()), home: options.home, exact: true })?.file
  // Pairing beside a configured node re-pairs it: the credentials stay, the URL is what moved.
  if (out && existsSync(out) && values.pair && !values.force) return pairExisting({ out, code: values.pair, rings: values.rings!, url: values.url })
  if (out && existsSync(out) && !values.force) {
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

  const root = resolve(answers.root)
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
  let contents = renderEnv({ root, mount, name, port, authToken, adminToken, choices })
  if (explicitOut) writeEnvironmentFile(resolve(explicitOut), contents)
  else {
    const registered = await registerWorkspaceConfig({ root, home: options.home, write(entry) {
      if (existsSync(entry.file) && !values.force) throw new Error('This workspace is already initialized; use --force only to replace its credentials')
      contents = renderEnv({ root: entry.root, mount, name, port, authToken, adminToken, choices, id: entry.id, state: entry.state })
      writeEnvironmentFile(entry.file, contents)
    } })
    out = registered.file
  }
  if (!out) throw new Error('Workspace configuration location was not selected')

  process.stdout.write(`Wrote ${out}

  Workspace   ${root}
  Seen as     ${mount ?? root}
  Name        ${name}
${describeChoices(choices)}${interactive ? '' : 'These are the defaults, kept because nothing was asked. Change one with: buckle settings set <key> <value>\n'}

Next:
  1. Start the node:            buckle serve        (discovers registered settings; custom files need BUCKLE_ENV_FILE)
  2. Register it in Rings with both credentials, or drive it directly:
       agent token        ${authToken}
       admin credential   ${adminToken}
  3. Restrict it:               buckle policy allow-command 'pnpm {build,test} *'
                                buckle policy allow-url localhost:3000

The agent token runs tools. The admin credential reads and pushes the policy at /setup, mints
and revokes workspace tokens, and nothing else. Keep them apart; Buckle refuses to start if
they are the same value.
`)

  if (!values.pair) return { exitCode: 0 }
  return pair({ out, contents, code: values.pair, rings: values.rings!, url: values.url, port })
}

/** Re-pairs a node that already has an environment file, keeping the credentials it holds. */
async function pairExisting(input: { out: string; code: string; rings: string; url?: string }): Promise<CliResult> {
  const contents = readFileSync(input.out, 'utf8')
  const port = /^BUCKLE_PORT=(\d+)$/m.exec(contents)?.[1] ?? '4320'
  process.stdout.write(`Pairing the node configured in ${input.out}; its credentials are unchanged.\n`)
  return pair({ ...input, contents, port })
}

async function pair(input: { out: string; contents: string; code: string; rings: string; url?: string; port: string }): Promise<CliResult> {
  const baseUrl = input.url?.trim() || `http://127.0.0.1:${input.port}`
  const result = await redeemPairingCode({ code: input.code, ringsUrl: input.rings, baseUrl, environmentFile: input.out, environmentText: input.contents })
  process.stdout.write(`\n${result.message}\n`)
  if (result.ok) process.stdout.write(`Rings will reach it at ${baseUrl}. Start it with: buckle serve\n`)
  return { exitCode: result.ok ? 0 : 1 }
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
  prompt.say('Host Git and forge tools read the repository outside the sandbox\'s per-file checks, so they start off (BUCKLE-D17).')
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

/** Only an answer that moved off the default adds a line; the rest stay as commented placeholders. */
function renderChoices(choices: NodeChoices): string {
  return `${choices.packs ? `BUCKLE_PACKS=${choices.packs.join(',')}` : '# BUCKLE_PACKS=fs,web,shell'}
BUCKLE_ALLOW_SHELL=${choices.shell}
# Host Git and forge tools read the repository outside per-file checks (BUCKLE-D17).
${choices.hostGit ? 'BUCKLE_ALLOW_HOST_GIT=true' : '# BUCKLE_ALLOW_HOST_GIT=true'}`
}

function renderEnv(input: { root: string; mount: string | null; name: string; port: string; authToken: string; adminToken: string; choices: NodeChoices; id?: string; state?: string }): string {
  return `# Written by buckle init on ${new Date().toISOString()}
# Registered settings are discovered from the workspace path. Custom files use BUCKLE_ENV_FILE.

BUCKLE_SERVER_ID=${input.id ?? slug(input.name)}
BUCKLE_SERVER_NAME=${input.name}
BUCKLE_HOST=127.0.0.1
BUCKLE_PORT=${input.port}

# What agents call tools with. Rings stores this one.
BUCKLE_AUTH_TOKEN=${input.authToken}
# What configures the node through /setup, mints workspace tokens and writes a persisted
# approval. Rings stores this one too, apart from the first.
BUCKLE_ADMIN_TOKEN=${input.adminToken}

BUCKLE_WORKSPACE_ROOT=${input.root}
${input.state ? `BUCKLE_STATE_DIR=${input.state}` : '# BUCKLE_STATE_DIR='}
${input.mount ? `BUCKLE_WORKSPACE_MOUNT=${input.mount}` : '# BUCKLE_WORKSPACE_MOUNT=/workspace'}
BUCKLE_SANDBOX=auto
# Milliseconds to wait for approval: 60000 = one minute; forever = no wait deadline.
# 0 returns approval instructions immediately. Restart serve after changing this.
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
