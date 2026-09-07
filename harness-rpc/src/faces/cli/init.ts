import { randomBytes } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { basename, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { MountPathSchema } from '@5straps/protocol'

export interface CliResult {
  exitCode: number
}

const USAGE = `Usage: buckle init [--root <dir>] [--mount <path>] [--name <name>] [--port <n>] [--out <file>] [--yes] [--force]

Writes an environment file for one workspace, with a fresh agent token and a fresh setup
token. Asks for the few decisions when run in a terminal; --yes takes the defaults.
`

/**
 * Onboards a workspace: one file the node starts from, two credentials that never meet. The
 * agent token is what a harness or Rings calls tools with; the setup token is what Rings
 * configures the node with, and no tool call can present it.
 */
export async function runInit(argv: string[]): Promise<CliResult> {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: 'string' },
      mount: { type: 'string' },
      name: { type: 'string' },
      port: { type: 'string' },
      out: { type: 'string' },
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

  const out = resolve(values.out ?? '.env')
  if (existsSync(out) && !values.force) {
    process.stderr.write(`${out} already exists. Pass --force to replace it, or --out to write elsewhere.\n`)
    return { exitCode: 1 }
  }

  const interactive = process.stdin.isTTY && !values.yes
  const answers = interactive
    ? await askInTerminal({ root: values.root, mount: values.mount, name: values.name })
    : { root: values.root ?? process.cwd(), mount: values.mount ?? null, name: values.name ?? null }

  const root = resolve(answers.root)
  const mount = answers.mount?.trim() || null
  if (mount && !MountPathSchema.safeParse(mount).success) {
    process.stderr.write(`Invalid mount path: ${mount}. Use an absolute path with plain segments, e.g. /workspace\n`)
    return { exitCode: 1 }
  }
  const name = answers.name?.trim() || `${basename(root)} on ${hostnameShort()}`
  const port = values.port ?? '4320'
  if (!/^\d+$/.test(port)) {
    process.stderr.write(`Invalid port: ${port}\n`)
    return { exitCode: 1 }
  }

  const authToken = token()
  const setupToken = token()
  writeFileSync(out, renderEnv({ root, mount, name, port, authToken, setupToken }), { mode: 0o600 })

  process.stdout.write(`Wrote ${out}

  Workspace   ${root}
  Seen as     ${mount ?? root}
  Name        ${name}

Next:
  1. Start the node:            buckle serve        (reads ${basename(out)} from this directory)
  2. Register it in Rings with both tokens, or drive it directly:
       agent token   ${authToken}
       setup token   ${setupToken}
  3. Restrict it:               buckle policy allow-command 'pnpm {build,test} *'
                                buckle policy allow-url localhost:3000

The agent token runs tools. The setup token reads and pushes the policy at /setup and nothing
else. Keep them apart; Buckle refuses to start if they are the same value.
`)
  return { exitCode: 0 }
}

async function askInTerminal(defaults: { root?: string; mount?: string; name?: string }) {
  const readline = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const root = (await readline.question(`Workspace root [${defaults.root ?? process.cwd()}]: `)).trim() || defaults.root || process.cwd()
    const mountAnswer = (await readline.question(`Show it to the agent as a virtual path? Enter one like /workspace, or leave empty [${defaults.mount ?? 'no'}]: `)).trim()
    const mount = mountAnswer || defaults.mount || null
    const name = (await readline.question(`Name for this node [${defaults.name ?? `${basename(resolve(root))} on ${hostnameShort()}`}]: `)).trim() || defaults.name || null
    return { root, mount, name }
  } finally {
    readline.close()
  }
}

function renderEnv(input: { root: string; mount: string | null; name: string; port: string; authToken: string; setupToken: string }): string {
  return `# Written by buckle init on ${new Date().toISOString()}
# The node reads this file from its working directory. Only BUCKLE_* names are taken from it.

BUCKLE_SERVER_ID=${slug(input.name)}
BUCKLE_SERVER_NAME=${input.name}
BUCKLE_HOST=127.0.0.1
BUCKLE_PORT=${input.port}

# What agents call tools with. Rings stores this one.
BUCKLE_AUTH_TOKEN=${input.authToken}
# What configures the node through /setup. Rings stores this one too, apart from the first.
BUCKLE_SETUP_TOKEN=${input.setupToken}

BUCKLE_WORKSPACE_ROOT=${input.root}
${input.mount ? `BUCKLE_WORKSPACE_MOUNT=${input.mount}` : '# BUCKLE_WORKSPACE_MOUNT=/workspace'}
BUCKLE_SANDBOX=auto
BUCKLE_ALLOW_SHELL=true

# The owner's constraints, as shell-word globs. One pattern per line inside double quotes, or
# separated by ;;  An allow glob covers the whole line, a deny glob everything starting with it.
# BUCKLE_COMMAND_ALLOW="docker compose {up,down,restart} *;;pnpm {build,test} *"
# BUCKLE_COMMAND_DENY="{sh,bash,node,python,python3,curl,wget}"
# Commands that ask first, added to the built-in destructive list, which nothing removes.
# BUCKLE_COMMAND_DESTRUCTIVE="terraform destroy *"
# BUCKLE_NETWORK_ALLOW=localhost:3000,*.example.com

# Where refused calls are reported as they happen (Rings: <rings>/api/v1/buckle-reports).
# BUCKLE_REPORT_URL=
# BUCKLE_REPORT_TOKEN=
`
}

function token(): string {
  return randomBytes(24).toString('base64url')
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'buckle'
}

function hostnameShort(): string {
  return (process.env.HOSTNAME ?? process.env.COMPUTERNAME ?? 'this machine').split('.')[0] ?? 'this machine'
}
