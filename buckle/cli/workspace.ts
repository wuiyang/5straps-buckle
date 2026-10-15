import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { resolve } from 'pathe'
import { ZodError } from 'zod'
import type { NodeConfig } from '../common/runtime/config.js'
import { workspaceArgument } from '../common/domain/approval-instruction.js'
import { PolicyError } from '../common/domain/policy.js'
import { WorkspaceError, WorkspaceNameTakenError, type MintedToken, type TakenUp, type WorkspaceDescriptor, type WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import { credentialLikeName, variableNameRefusal, WorkspaceSettingsConflictError, WorkspaceSettingsInvalidError } from '../common/services/workspaces/workspace-settings.js'
import { SETTING_KEYS, SettingValueError, type SettingKey } from './workspace-keys.js'
import { takeTarget, TargetError, type CommandTarget } from './target.js'

export interface CliResult {
  exitCode: number
  /** For the audit entry: what changed, never a token or a variable's value. */
  detail?: string
}

/** Where `init` and `add` ask for another name when the one they would use is taken (D85, Q15): a terminal, unless a test scripts the answers. */
export interface NamePrompt {
  interactive: boolean
  question(text: string): Promise<string>
  close(): void
}

const USAGE = `Usage: buckle workspace <verb>. A verb that takes no name acts on the workspace --workspace <name> names, or
the one whose folder holds --dir <path>, or else the current directory. <name> is a workspace's name, or its id.

  buckle workspace init [--dir <path>] [--name <name>] [--yes]
                                       Serve a folder as a workspace, and print its agent token once
  buckle workspace add <dir> [--name <name>] [--yes] [--fresh]
                                       The same, with the folder named first; --fresh leaves any removed records behind
  buckle workspace prune [--yes]       The removed workspaces whose records are still kept; --yes deletes them
  buckle workspace list [--json]       Every workspace, online or not
  buckle workspace show [--json]       Its settings; no token is ever shown
  buckle workspace enable <name> | disable <name>
                                       Serve it, or stop serving it, as an MCP server is switched
  buckle workspace rename <name> <new-name>
                                       Give it another name; its id never changes
  buckle workspace remove <name> [--purge]
                                       Forget it; its records stay (adding the folder again takes them up) unless --purge
  buckle workspace set <key> <value> | unset <key>
                                       Change one setting: name, env.<NAME>, or a key buckle workspace show lists
  buckle workspace token create [--label <text>] | list | revoke <token-id>
                                       Mint an agent token, shown once; list them; refuse one from now on

A name that another workspace holds is asked about at a terminal; with --yes, or none, the command is refused.
`

/**
 * The owner's workspace commands (D83 (2) to (6), the workspace-model brief, item 4). `BUCKLE-D12` names the admin
 * credential as the one authority that mints or revokes a workspace token, so every verb refuses on a node configured
 * without one, and `SELF_ADMINISTRATION` in the command policy keeps a tool from reaching them. A workspace is named
 * by its name wherever a verb takes one (D85, Q15); its id is accepted too.
 */
export async function workspaceRegistryCommand(input: { config: NodeConfig; workspaces: WorkspaceManager; argv: string[]; cwd: string; prompt?: NamePrompt }): Promise<CliResult> {
  if (!input.config.adminToken) return fail('This node has no admin credential. Set BUCKLE_ADMIN_TOKEN, or run buckle init, before minting workspace credentials.')
  let target: CommandTarget
  let argv: string[]
  try { ({ target, argv } = takeTarget(input.argv)) } catch (error) {
    if (error instanceof TargetError) return fail(error.message)
    throw error
  }
  const [verb = 'show', ...rest] = argv
  const prompt = input.prompt ?? terminalPrompt()
  const context = { ...input, target, rest, prompt }
  try {
    switch (verb) {
      case 'init': return await init(context)
      case 'add': return await add(context)
      case 'list': return list(context)
      case 'show': return show(context)
      case 'enable': return await online(context, true)
      case 'disable': return await online(context, false)
      case 'rename': return await rename(context)
      case 'remove': return await remove(context)
      case 'prune': return prune(context)
      case 'set': return await set(context)
      case 'unset': return await unset(context)
      case 'token': return await token(context)
      case 'help': case '--help': case '-h':
        process.stdout.write(USAGE)
        return { exitCode: 0 }
      default: return fail(USAGE)
    }
  } catch (error) {
    if (error instanceof WorkspaceError || error instanceof SettingValueError || error instanceof WorkspaceSettingsInvalidError || error instanceof WorkspaceSettingsConflictError || error instanceof PolicyError) return fail(error.message)
    if (error instanceof ZodError) return fail(error.issues.map(issue => `${issue.path.join('.') || 'value'}: ${issue.message}`).join('; '))
    throw error
  } finally {
    prompt.close()
  }
}

interface Context { config: NodeConfig; workspaces: WorkspaceManager; target: CommandTarget; rest: string[]; cwd: string; prompt: NamePrompt }

/** `buckle workspace init`: the folder --dir names, relative to where it runs, or that directory; the token printed once. */
async function init(context: Context): Promise<CliResult> {
  let values: { name?: string; yes?: boolean }
  // 0.1's `--id` went with the typed id (D85, Q15): an unknown flag is refused with the usage, as `add` refuses `--root`.
  try { ({ values } = parseArgs({ args: context.rest, options: { name: { type: 'string' }, yes: { type: 'boolean' } }, allowPositionals: false })) } catch (error) {
    return fail(`${(error instanceof Error ? error.message : String(error)).split('. ')[0]}\nUsage: buckle workspace init [--dir <folder>] [--name <name>] [--yes]`)
  }
  if (context.target.workspace !== undefined) return fail('buckle workspace init makes a workspace: name its folder with --dir, and its name with --name')
  const dir = resolve(context.cwd, context.target.dir ?? '.')
  return serve(context, { dir, name: values.name, yes: values.yes === true })
}

/** `buckle workspace add <dir> [--name <name>]`: init with the folder named first (D85, Q15). */
async function add(context: Context): Promise<CliResult> {
  const usage = 'Usage: buckle workspace add <dir> [--name <name>] [--yes]'
  const usageFresh = 'Usage: buckle workspace add <dir> [--name <name>] [--yes] [--fresh]'
  let parsed: ReturnType<typeof parseArgs<{ options: { name: { type: 'string' }; yes: { type: 'boolean' }; fresh: { type: 'boolean' } }; allowPositionals: true }>>
  // The 0.1 spelling, `add <id> --root <dir>`, went with the typed id (D85, Q15): its flag is refused with the usage.
  try { parsed = parseArgs({ args: context.rest, options: { name: { type: 'string' }, yes: { type: 'boolean' }, fresh: { type: 'boolean' } }, allowPositionals: true }) } catch { return fail(usageFresh) }
  const [dir] = parsed.positionals
  if (!dir || parsed.positionals.length !== 1 || context.target.workspace !== undefined || context.target.dir !== undefined) return fail(usageFresh)
  return serve(context, { dir: resolve(context.cwd, dir), name: parsed.values.name, yes: parsed.values.yes === true, fresh: parsed.values.fresh === true })
}

/**
 * Serves a folder as a new workspace, named as asked, or after its folder. A name another workspace holds is asked
 * about at a terminal until one is free; with --yes, or no terminal, it is refused, naming --name (D85, Q15).
 */
async function serve(context: Context, input: { dir: string; name?: string; yes: boolean; fresh?: boolean }): Promise<CliResult> {
  const { workspace, token, takenUp } = await createNamed(context.prompt, { ...input, refusal: 'name it with --name <name>' }, name => context.workspaces.create({ dir: input.dir, ...(input.fresh ? { fresh: true } : {}), ...(name === undefined ? {} : { name }) }))
  printMinted(workspace, token, takenUp)
  return { exitCode: 0, detail: `init ${workspace.name}` }
}

/**
 * Runs `create` with the name given, then with each name the owner types in place of one that is taken; `refusal`
 * says how to name it where nobody can be asked (--yes, or no terminal).
 */
export async function createNamed<T>(prompt: NamePrompt, input: { name?: string; yes: boolean; refusal: string }, create: (name: string | undefined) => Promise<T>): Promise<T> {
  let name = input.name
  for (;;) {
    try { return await create(name) } catch (error) {
      if (!(error instanceof WorkspaceNameTakenError)) throw error
      if (input.yes || !prompt.interactive) throw new WorkspaceError(`${error.message}: ${input.refusal}`, 409)
      const answer = (await prompt.question(`${error.message}. Another name, or Enter to stop: `)).trim()
      if (answer === '') throw new WorkspaceError(`No name given, so nothing was added; ${input.refusal}`, 409)
      name = answer
    }
  }
}

function printMinted(workspace: WorkspaceDescriptor, token: MintedToken, takenUp: TakenUp | null): void {
  process.stdout.write(`Workspace ${workspace.name} serves ${workspace.dir}, online.${takenUp ? ` It takes up the records this folder left when its workspace was removed: its settings, grants, and history${takenUp.dangerouslyAllow ? ', and its dangerously-allow switch, which is ON' : ''}.` : ''}

  agent token   ${token.token}

Shown once. An agent sends it to /mcp or /v1 on this node, which serve this workspace for it; mint more with
buckle workspace token create --workspace ${workspaceArgument(workspace.name)}.
`)
}

function list(context: Context): CliResult {
  const { values } = parseArgs({ args: context.rest, options: { json: { type: 'boolean' } }, allowPositionals: false })
  const workspaces = context.workspaces.list()
  if (values.json) return print(workspaces)
  if (workspaces.length === 0) {
    process.stdout.write('No workspace yet: run buckle workspace init in the folder to serve.\n')
    return { exitCode: 0 }
  }
  for (const workspace of workspaces) process.stdout.write(`${workspace.name.padEnd(24)} ${(workspace.online ? 'online' : 'offline').padEnd(8)} ${workspace.id}  ${workspace.dir}\n`)
  return { exitCode: 0 }
}

/** The workspace and its settings, whole: workspace.json holds no credential, and the registry's token digests are left out. */
function show(context: Context): CliResult {
  const { values } = parseArgs({ args: context.rest, options: { json: { type: 'boolean' } }, allowPositionals: false })
  const workspace = targeted(context)
  const settings = context.workspaces.settings(workspace.id)
  if (values.json) return print({ ...workspace, settings })
  const named = workspaceArgument(workspace.name)
  process.stdout.write(`Workspace ${workspace.name} (id ${workspace.id}), ${workspace.online ? 'online' : 'offline'}, ${workspace.tokens} agent token${workspace.tokens === 1 ? '' : 's'}
Folder    ${workspace.dir}
${JSON.stringify(settings, null, 2)}

Change a setting with buckle workspace set <key> <value> --workspace ${named}; the keys:
  name                    the workspace's name
  env.<NAME>              a variable its commands see; a credential's name is refused
${SETTING_KEYS.map(key => `  ${key.key.padEnd(24)}${key.takes}`).join('\n')}
Its policy lists change with buckle policy --workspace ${named}.
`)
  return { exitCode: 0 }
}

async function online(context: Context, on: boolean): Promise<CliResult> {
  const named = handle(context, onlyHandle(context.rest, on ? 'enable' : 'disable'))
  const workspace = await context.workspaces.update(named.id, { online: on })
  process.stdout.write(`Workspace ${workspace.name} is ${on ? 'online: buckle serve serves it at its next call' : 'offline: calls to it are refused, and its files, records and tokens stay'}.\n`)
  return { exitCode: 0, detail: `${on ? 'enable' : 'disable'} ${workspace.name}` }
}

/** `buckle workspace rename <name> <new-name>`: the name changes, the id never does (D85, Q15). */
async function rename(context: Context): Promise<CliResult> {
  const [from, to, ...extra] = context.rest
  if (!from || !to || extra.length > 0) return fail('Usage: buckle workspace rename <name> <new-name>')
  const named = handle(context, from)
  const workspace = await context.workspaces.update(named.id, { name: to })
  process.stdout.write(`Workspace ${named.name} is now named ${workspace.name}; its id ${workspace.id} is unchanged.\n`)
  return { exitCode: 0, detail: `rename ${named.name} ${workspace.name}` }
}

async function remove(context: Context): Promise<CliResult> {
  const { positionals, values } = parseArgs({ args: context.rest, options: { purge: { type: 'boolean' } }, allowPositionals: true })
  const named = handle(context, onlyHandle(positionals, 'remove'))
  const removed = await context.workspaces.remove(named.id, { purge: values.purge === true })
  process.stdout.write(values.purge
    ? `Removed workspace ${removed.name} and deleted its records. Its folder ${removed.dir} is untouched.\n`
    : `Removed workspace ${removed.name}. Its folder ${removed.dir} is untouched, and its records stay in the state directory under workspaces/${removed.id}/: serving the folder again takes them up.\n`)
  return { exitCode: 0, detail: `remove ${removed.name}${values.purge ? ' --purge' : ''}` }
}

/** `buckle workspace prune [--yes]`: the removed workspaces whose records are still kept, and, with --yes, their deletion (addendum to D85, Q15). */
function prune(context: Context): CliResult {
  const { values } = parseArgs({ args: context.rest, options: { yes: { type: 'boolean' } }, allowPositionals: false })
  const removed = context.workspaces.prune({ yes: values.yes === true })
  if (removed.length === 0) {
    process.stdout.write('No removed workspace has records left to prune.\n')
    return { exitCode: 0 }
  }
  if (!values.yes) {
    process.stdout.write('Removed workspaces whose records are still kept:\n')
    for (const entry of removed) process.stdout.write(`  ${entry.name}  ${entry.dir}${entry.removedAt ? `  removed ${entry.removedAt}` : ''}  (workspaces/${entry.id}/)\n`)
    process.stdout.write('Delete their records with buckle workspace prune --yes; adding a folder again takes its records up instead.\n')
    return { exitCode: 0 }
  }
  for (const entry of removed) process.stdout.write(`Deleted the records of ${entry.name} (${entry.dir}).\n`)
  return { exitCode: 0, detail: `prune ${removed.length}` }
}

/** One setting, validated whole with the rest before it is written (openSettingsFile). A variable's value is never echoed or audited. */
async function set(context: Context): Promise<CliResult> {
  const [key, value, ...extra] = context.rest
  if (!key || value === undefined || extra.length > 0) return fail('Usage: buckle workspace set <key> <value>; quote a value of several words as one')
  const workspace = targeted(context)
  if (key === 'name') {
    const renamed = await context.workspaces.update(workspace.id, { name: value })
    process.stdout.write(`Workspace ${workspace.name} is now named ${renamed.name}.\n`)
    return { exitCode: 0, detail: `set ${workspace.name} name` }
  }
  if (key.startsWith('env.')) {
    const name = key.slice('env.'.length)
    const refusal = variableNameRefusal(name) ?? credentialValueRefusal(context, value)
    if (refusal) return fail(refusal)
    await context.workspaces.updateSettings(workspace.id, settings => ({ ...settings, env: { ...settings.env, [name]: value } }))
    // Q13: a credential-like name is taken, with a warning, since the value is plain text in workspace.json and reaches every command.
    if (credentialLikeName(name)) process.stdout.write(`${name} looks like a credential (a token, secret, password, or key): its value is stored in plain text in workspace.json and is passed to every command this workspace runs. Keep real secrets in your own secret store.\n`)
    process.stdout.write(`Workspace ${workspace.name}'s commands see ${name}.\n`)
    return { exitCode: 0, detail: `set ${workspace.name} env.${name}` }
  }
  const setting = settingKey(key)
  if (typeof setting === 'string') return fail(setting)
  await context.workspaces.updateSettings(workspace.id, settings => setting.set(settings, value))
  process.stdout.write(`Workspace ${workspace.name}: ${key} is set.\n`)
  return { exitCode: 0, detail: `set ${workspace.name} ${key} ${value}` }
}

async function unset(context: Context): Promise<CliResult> {
  const [key, ...extra] = context.rest
  if (!key || extra.length > 0) return fail('Usage: buckle workspace unset <key>')
  const workspace = targeted(context)
  if (key.startsWith('env.')) {
    const name = key.slice('env.'.length)
    await context.workspaces.updateSettings(workspace.id, (settings) => {
      const { [name]: _dropped, ...env } = settings.env
      return { ...settings, env }
    })
    process.stdout.write(`Workspace ${workspace.name}'s commands no longer see ${name}.\n`)
    return { exitCode: 0, detail: `unset ${workspace.name} env.${name}` }
  }
  const setting = settingKey(key)
  if (typeof setting === 'string') return fail(setting)
  await context.workspaces.updateSettings(workspace.id, settings => setting.unset(settings))
  process.stdout.write(`Workspace ${workspace.name}: ${key} is back to its default.\n`)
  return { exitCode: 0, detail: `unset ${workspace.name} ${key}` }
}

/**
 * The key `set` and `unset` change, or why none is. The browser block of workspace.json is stored, from migration, but
 * the browser runs on the node's own settings until it reads each workspace's (the workspace-model brief, Phase 2
 * item 6), so no command writes a value that would not take effect.
 */
function settingKey(key: string): SettingKey | string {
  if (key.startsWith('browser.')) return `${key} does not take effect yet: the browser runs on the node's BUCKLE_BROWSER_CDP, BUCKLE_BROWSER_PROFILE, BUCKLE_BROWSER_ARGS, and BUCKLE_BROWSER_HEADED until it reads each workspace's own, so buckle workspace set leaves it alone`
  return SETTING_KEYS.find(item => item.key === key) ?? `${key} is no workspace setting; buckle workspace show lists them`
}

/**
 * A value holding one of this node's secrets never becomes a variable a command reads (no secret reaches a child
 * process): the admin and agent tokens, the forge token, the Brave key, the Rings report token and pairing key, and the
 * approval webhook's URL, anywhere in the value, and a workspace's agent token as a word of it, which only its digest
 * can recognise (finding 26 of the Phase 1 review).
 */
function credentialValueRefusal(context: Context, value: string): string | null {
  const { config } = context
  const secrets = [config.adminToken, config.authToken, config.forgeGithubToken, config.braveSearchApiKey, config.reportToken, config.ringsApprovalKey?.secret.toString('base64url'), config.approvalWebhook]
    .flatMap(secret => (secret?.trim() ? [secret.trim()] : []))
  const words = [value.trim(), ...value.split(/[^A-Za-z0-9_-]+/)].filter(Boolean)
  const held = secrets.some(secret => value.includes(secret)) || words.some(word => context.workspaces.tokenOwner(`Bearer ${word}`) !== null)
  return held ? 'That value holds one of this node\'s credentials, and no secret reaches a command Buckle runs' : null
}

/** How many words a 0.1 `token` spelling takes, its workspace's name first. */
const LEGACY_POSITIONALS: Readonly<Record<string, number>> = { add: 1, list: 1, revoke: 2 }

/** `token create|list|revoke` on the target workspace, and the 0.1 spellings that name the workspace first, for one release. */
async function token(context: Context): Promise<CliResult> {
  const [action, ...words] = context.rest
  const { positionals, values } = parseArgs({ args: words, options: { label: { type: 'string' } }, allowPositionals: true })
  const flagged = context.target.workspace !== undefined || context.target.dir !== undefined
  const legacy = (count: number) => positionals.length === count && !flagged
  // A 0.1 spelling's name beside --workspace or --dir names two workspaces; minting for one of them would be a guess (finding 32).
  if (flagged && action !== undefined && positionals.length === LEGACY_POSITIONALS[action]) return fail(`Name the workspace once: buckle workspace token ${action} <name>${action === 'revoke' ? ' <token-id>' : ''}, the 0.1 spelling, or buckle workspace token ${action === 'add' ? 'create' : action}${action === 'revoke' ? ' <token-id>' : ''} --workspace <name>`)
  if (action === 'create' || action === 'add') {
    if (positionals.length > (action === 'add' ? 1 : 0)) return fail('Usage: buckle workspace token create [--label <text>]')
    const workspace = action === 'add' && legacy(1) ? handle(context, positionals[0]!) : targeted(context)
    const minted = await context.workspaces.addToken(workspace.id, { label: values.label })
    process.stdout.write(`Minted ${minted.id} for workspace ${workspace.name}

  agent token   ${minted.token}

Shown once. Revoke it with buckle workspace token revoke ${minted.id} --workspace ${workspaceArgument(workspace.name)}.
`)
    return { exitCode: 0, detail: `token create ${workspace.name} ${minted.id}` }
  }
  if (action === 'list') {
    if (positionals.length > 1) return fail('Usage: buckle workspace token list')
    const workspace = legacy(1) ? handle(context, positionals[0]!) : targeted(context)
    return print(context.workspaces.listTokens(workspace.id))
  }
  if (action === 'revoke') {
    if (positionals.length < 1 || positionals.length > 2) return fail('Usage: buckle workspace token revoke <token-id>')
    const [workspace, tokenId] = legacy(2) ? [handle(context, positionals[0]!), positionals[1]!] : [targeted(context), positionals[0]!]
    if (!await context.workspaces.revokeToken(workspace.id, tokenId)) return fail(`Workspace ${workspace.name} holds no token ${tokenId}`)
    process.stdout.write(`Revoked ${tokenId}. Calls presenting it are refused from now on.\n`)
    return { exitCode: 0, detail: `token revoke ${workspace.name} ${tokenId}` }
  }
  return fail(USAGE)
}

/** The workspace the command targets (D83 (4)): --workspace, --dir, or the folder holding the current directory. */
function targeted(context: Context): WorkspaceDescriptor {
  return handle(context, context.workspaces.target({ ...context.target, cwd: context.cwd }))
}

/** The workspace a name or id names, refused with the names where none does. */
function handle(context: Context, named: string): WorkspaceDescriptor {
  return context.workspaces.lookup(context.workspaces.target({ workspace: named, cwd: context.cwd }))!
}

/** The one name a verb names. */
function onlyHandle(words: readonly string[], verb: string): string {
  const [name, ...extra] = words
  if (!name || extra.length > 0) throw new WorkspaceError(`Usage: buckle workspace ${verb} <name>`)
  return name
}

/** Questions on stderr, so stdout stays the answer; asked only where both ends are a terminal. */
function terminalPrompt(): NamePrompt {
  let readline: ReturnType<typeof createInterface> | null = null
  return {
    interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    question: text => (readline ??= createInterface({ input: process.stdin, output: process.stderr })).question(text),
    close: () => readline?.close(),
  }
}

function print(value: unknown): CliResult {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  return { exitCode: 0 }
}

function fail(message: string): CliResult {
  process.stderr.write(`${message}\n`)
  return { exitCode: 1 }
}
