import type { CliResult } from './result.js'
import { BUCKLE_BUILD } from '../common/runtime/version.js'
import { helpLines, MODES_HELP } from './dangerously-allow-words.js'
import { asksForHelp } from './help-request.js'
import { APPROVALS_USAGE, APPROVE_USAGE, BROWSER_CLOSE_USAGE, CHECK_URL_USAGE, GRANTS_USAGE, HISTORY_USAGE, KEYS_USAGE, PLUGIN_USAGE, POLICY_USAGE, WORKSPACES_USAGE, WORKSPACE_USAGE, isBrowserClose } from './usage.js'

/** The usage each audited owner command prints for a help request. */
const COMMAND_USAGE: ReadonlyMap<string, string> = new Map([
  ['approve', APPROVE_USAGE], ['approvals', APPROVALS_USAGE], ['check-url', CHECK_URL_USAGE], ['grants', GRANTS_USAGE], ['workspaces', WORKSPACES_USAGE],
  ['history', HISTORY_USAGE], ['plugin', PLUGIN_USAGE], ['policy', POLICY_USAGE], ['workspace', WORKSPACE_USAGE], ['keys', KEYS_USAGE],
])

/** The commands whose own first word `help` also asks for the usage. */
const HELP_WORD_COMMANDS: readonly string[] = Object.freeze(['policy', 'workspace'])

/** Help and the version, which need no configuration; null for every other command. */
export function answerWithoutConfiguration(argv: string[]): CliResult | null {
  const [command, ...rest] = argv
  if (!command || command === 'help' || command === '--help' || command === '-h') return printUsage()
  if (command === '--version' || command === '-v') return printVersion()
  // A help request on an owner's command is answered here, before any workspace is found or any entry is written to the log.
  const usage = COMMAND_USAGE.get(command)
  if (usage !== undefined && (asksForHelp(rest) || (rest[0] === 'help' && HELP_WORD_COMMANDS.includes(command)))) return printCommandUsage(usage)
  // `buckle browser` runs the browser's tools; only its `close` is the owner's own command.
  if (isBrowserClose(command, rest) && asksForHelp(rest)) return printCommandUsage(BROWSER_CLOSE_USAGE)
  return null
}

function printVersion(): CliResult {
  process.stdout.write(`${BUCKLE_BUILD}\n`)
  return { exitCode: 0 }
}

function printCommandUsage(usage: string): CliResult {
  process.stdout.write(usage.endsWith('\n') ? usage : `${usage}\n`)
  return { exitCode: 0 }
}

function printUsage(): CliResult {
  process.stdout.write(`buckle ${BUCKLE_BUILD}, the 5straps execution node

  buckle init                        Set this machine's node up once, and serve the current folder as a
                                     workspace; prints its agent token once
  buckle serve [--background]        Serve every online workspace over HTTP: native RPC and MCP; detached
                                     from this terminal with --background
  buckle service install [--now] | uninstall | start | stop | restart | status [--json] | logs [-f] [-n N]
                                     Run the node with no terminal, starting at every login
  buckle mcp [--workspace <name> | --dir <path>]   Serve one workspace's MCP over stdio

  A command acts on the workspace --workspace <name> or --dir <path> names, else on the one whose
  folder holds the current directory. A workspace's name is the folder's by default; its id is taken too.

  buckle tools                       List available tools
  buckle manifest                    Print the full manifest
  buckle skills [name]               List skills, or print one

  buckle <group> <verb> [args]       Run a tool, e.g. buckle fs read src/app.ts
  buckle call <tool> --json '{...}'  Run a tool with raw JSON arguments
  buckle cp <from> <to> [--node <url>] [--token-file <file>]
                                     Copy one file between here and a workspace on a node, as
                                     <path> and <workspace>:<path>; see buckle cp --help

  buckle approvals [--json] [--workspace <name> | --all]   Requests waiting for a decision (the current workspace, or every online one)
  buckle approvals --watch [--workspace <name> | --all]    Ask about each request as it arrives
  buckle approvals show <token> [--json] [--workspace <name>]
                                   One request whole, and the code_run script that made it
  buckle approvals judge <token> [--approve-if-safe] [--workspace <name>]
                                   The decision AI's verdicts on one request, beside its whole action;
                                   --approve-if-safe approves an interpreter request, or an allowed command the
                                   quick stage turned into an ask, once where the thorough stage rates it safe
                                   at 0.8 or above, and never one at the destructive floor
  buckle approve <token> [--scope once|session|always] [--host '*.example.com' | --below] [--deny] [--workspace <name> | --all]
                                   Shows the whole action, then approves only once you confirm at a terminal
  buckle check-url <url|host> [--session <id>] [--workspace <name>]   Exits 0 approved, 1 denied, 3 asks, 4 not listed
  buckle grants list | revoke <id>
  buckle workspace init [--dir <path>] [--name <name>] | add <dir> [--name <name>] | list | show [--json]
  buckle workspace enable <name> | disable <name> | rename <name> <new-name> | remove <name> [--purge]
  buckle workspace set <key> <value> | unset <key>
  buckle workspace token create [--label <text>] | list | revoke <token-id>
  buckle workspaces list | inspect <id> | publish <id> | discard <id> | prune
  buckle history list [--last <n>] | restore <id> | restore-stage <stage> <session> | recover <id> | prune
                                   The change history; --last shows n checkpoints back from the current one
  buckle browser close [--workspace <name>]   End every browser the workspace's agents left open, and the
                                   secret values their pages hold
  buckle log [--limit N] [--json]    Show what this node actually did
  buckle plugin list | add <id> <specifier> | remove <id>
  buckle policy show | allow-command | deny-command | allow-url | mount | ...
  buckle policy deny-tool <tool> | allow-tool <tool>   Refuse a tool outright, or lift that
  buckle policy dangerously-allow on|safe|off
${helpLines({ text: `DANGEROUS: allow asks in the workspace without a person; ${MODES_HELP}. See buckle policy --help`, indent: 35, width: 92 })}
  buckle settings show | set <key> <value> | unset <key>   Node settings in the environment file
  buckle keys enroll <public-key> --purpose <p> --workspace <w> | list | revoke <key-id>
                                   Client keys trusted for signed setup and approvals, by scope
  buckle client keygen | key | request <METHOD> <url> | approve <node-url> <token>
                                   This device's signing key, a signed request with it, and a signed approval

  buckle --version                   Print the version
  buckle <command> --skip-owner-only-check   Warn about, rather than refuse, a state directory or key file other users can reach
  buckle <command> --ignore-warning   Run an owner's command whose record the audit log cannot take, which otherwise
                                     stops naming the error (exit 6); its record is still tried. Never a tool call
`)
  return { exitCode: 0 }
}
