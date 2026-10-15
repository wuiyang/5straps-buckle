import { parseArgs } from 'node:util'
import { resolve } from 'pathe'
import { ZodError } from 'zod'
import type { NodeConfig } from '../common/runtime/config.js'
import { PolicyError } from '../common/domain/policy.js'
import { WorkspaceError, type MintedToken, type TakenUp, type WorkspaceDescriptor, type WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import { variableNameRefusal, WorkspaceSettingsConflictError, WorkspaceSettingsInvalidError } from '../common/services/workspaces/workspace-settings.js'
import { SETTING_KEYS, SettingValueError, type SettingKey } from './workspace-keys.js'
import { takeTarget, TargetError, type CommandTarget } from './target.js'

export interface CliResult {
  exitCode: number
  /** For the audit entry: what changed, never a token or a variable's value. */
  detail?: string
}

const USAGE = `Usage: buckle workspace <verb>. A verb that takes no id acts on the workspace --workspace <id> names, or
the one whose folder holds --dir <path>, or else the current directory.

  buckle workspace init [--dir <path>] [--name <name>] [--id <id>]
                                       Serve a folder as a workspace, and print its agent token once
  buckle workspace list [--json]       Every workspace, online or not
  buckle workspace show [--json]       Its settings; no token is ever shown
  buckle workspace enable <id> | disable <id>
                                       Serve it, or stop serving it, as an MCP server is switched
  buckle workspace remove <id> [--purge]
                                       Forget it; its records stay unless --purge; its folder is never touched
  buckle workspace set <key> <value> | unset <key>
                                       Change one setting: name, env.<NAME>, or a key buckle workspace show lists
  buckle workspace token create [--label <text>] | list | revoke <token-id>
                                       Mint an agent token, shown once; list them; refuse one from now on
`

/**
 * The owner's workspace commands (D83 (2) to (6), the workspace-model brief, item 4). `BUCKLE-D12` names the admin
 * credential as the one authority that mints or revokes a workspace token, so every verb refuses on a node configured
 * without one, and `SELF_ADMINISTRATION` in the command policy keeps a tool from reaching them.
 */
export async function workspaceRegistryCommand(input: { config: NodeConfig; workspaces: WorkspaceManager; argv: string[]; cwd: string }): Promise<CliResult> {
  if (!input.config.adminToken) return fail('This node has no admin credential. Set BUCKLE_ADMIN_TOKEN, or run buckle init, before minting workspace credentials.')
  let target: CommandTarget
  let argv: string[]
  try { ({ target, argv } = takeTarget(input.argv)) } catch (error) {
    if (error instanceof TargetError) return fail(error.message)
    throw error
  }
  const [verb = 'show', ...rest] = argv
  const context = { ...input, target, rest }
  try {
    switch (verb) {
      case 'init': return await init(context)
      // Kept for one release beside `init`, which takes its folder from --dir or the current directory.
      case 'add': return await add(context)
      case 'list': return list(context)
      case 'show': return show(context)
      case 'enable': return await online(context, true)
      case 'disable': return await online(context, false)
      case 'remove': return await remove(context)
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
  }
}

interface Context { config: NodeConfig; workspaces: WorkspaceManager; target: CommandTarget; rest: string[]; cwd: string }

/** `buckle workspace init`: the folder --dir names, relative to where it runs, or that directory; the token printed once. */
async function init(context: Context): Promise<CliResult> {
  const { values } = parseArgs({ args: context.rest, options: { name: { type: 'string' }, id: { type: 'string' } }, allowPositionals: false })
  if (context.target.workspace !== undefined) return fail('buckle workspace init makes a workspace: name its folder with --dir, and its id with --id')
  const dir = resolve(context.cwd, context.target.dir ?? '.')
  const { workspace, token, takenUp } = await context.workspaces.create({ dir, ...(values.name ? { name: values.name } : {}), ...(values.id ? { id: values.id } : {}) })
  printMinted(workspace, token, takenUp)
  return { exitCode: 0, detail: `init ${workspace.id}` }
}

/** `buckle workspace add <id> --root <dir>`, the 0.1 spelling of init. */
async function add(context: Context): Promise<CliResult> {
  const { positionals, values } = parseArgs({ args: context.rest, options: { root: { type: 'string' }, name: { type: 'string' } }, allowPositionals: true })
  const [id] = positionals
  if (!id || !values.root || positionals.length !== 1) return fail('Usage: buckle workspace add <id> --root <dir> [--name <name>], kept for one release: buckle workspace init --dir <dir> --id <id>')
  const { workspace, token, takenUp } = await context.workspaces.create({ id, dir: resolve(context.cwd, values.root), name: values.name ?? id })
  printMinted(workspace, token, takenUp)
  return { exitCode: 0, detail: `init ${workspace.id}` }
}

function printMinted(workspace: WorkspaceDescriptor, token: MintedToken, takenUp: TakenUp | null): void {
  process.stdout.write(`Workspace ${workspace.id} serves ${workspace.dir}, online.${takenUp ? ` It takes up the records workspace ${workspace.id} left when it was removed: its settings, grants, and history${takenUp.dangerouslyAllow ? ', and its dangerously-allow switch, which is ON' : ''}.` : ''}

  agent token   ${token.token}

Shown once. An agent sends it to /mcp or /v1 on this node, which serve this workspace for it; mint more with
buckle workspace token create --workspace ${workspace.id}.
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
  for (const workspace of workspaces) process.stdout.write(`${workspace.id.padEnd(20)} ${(workspace.online ? 'online' : 'offline').padEnd(8)} ${workspace.name}  ${workspace.dir}\n`)
  return { exitCode: 0 }
}

/** The workspace and its settings, whole: workspace.json holds no credential, and the registry's token digests are left out. */
function show(context: Context): CliResult {
  const { values } = parseArgs({ args: context.rest, options: { json: { type: 'boolean' } }, allowPositionals: false })
  const id = context.workspaces.target({ ...context.target, cwd: context.cwd })
  const workspace = context.workspaces.list().find(item => item.id === id)!
  const settings = context.workspaces.settings(id)
  if (values.json) return print({ ...workspace, settings })
  process.stdout.write(`Workspace ${workspace.id} (${workspace.name}), ${workspace.online ? 'online' : 'offline'}, ${workspace.tokens} agent token${workspace.tokens === 1 ? '' : 's'}
Folder    ${workspace.dir}
${JSON.stringify(settings, null, 2)}

Change a setting with buckle workspace set <key> <value> --workspace ${workspace.id}; the keys:
  name                    the workspace's name
  env.<NAME>              a variable its commands see; a credential's name is refused
${SETTING_KEYS.map(key => `  ${key.key.padEnd(24)}${key.takes}`).join('\n')}
Its policy lists change with buckle policy --workspace ${workspace.id}.
`)
  return { exitCode: 0 }
}

async function online(context: Context, on: boolean): Promise<CliResult> {
  const id = onlyId(context.rest, on ? 'enable' : 'disable')
  const workspace = await context.workspaces.update(id, { online: on })
  process.stdout.write(`Workspace ${workspace.id} is ${on ? 'online: buckle serve serves it at its next call' : 'offline: calls to it are refused, and its files, records and tokens stay'}.\n`)
  return { exitCode: 0, detail: `${on ? 'enable' : 'disable'} ${id}` }
}

async function remove(context: Context): Promise<CliResult> {
  const { positionals, values } = parseArgs({ args: context.rest, options: { purge: { type: 'boolean' } }, allowPositionals: true })
  const id = onlyId(positionals, 'remove')
  const removed = await context.workspaces.remove(id, { purge: values.purge === true })
  process.stdout.write(values.purge
    ? `Removed workspace ${removed.id} and deleted its records. Its folder ${removed.dir} is untouched.\n`
    : `Removed workspace ${removed.id}. Its folder ${removed.dir} is untouched, and its records stay in the state directory: buckle workspace init --dir <folder> --id ${removed.id} takes them up again.\n`)
  return { exitCode: 0, detail: `remove ${id}${values.purge ? ' --purge' : ''}` }
}

/** One setting, validated whole with the rest before it is written (openSettingsFile). A variable's value is never echoed or audited. */
async function set(context: Context): Promise<CliResult> {
  const [key, value, ...extra] = context.rest
  if (!key || value === undefined || extra.length > 0) return fail('Usage: buckle workspace set <key> <value>; quote a value of several words as one')
  const id = context.workspaces.target({ ...context.target, cwd: context.cwd })
  if (key === 'name') {
    await context.workspaces.update(id, { name: value })
    process.stdout.write(`Workspace ${id} is named ${value}.\n`)
    return { exitCode: 0, detail: `set ${id} name` }
  }
  if (key.startsWith('env.')) {
    const name = key.slice('env.'.length)
    const refusal = variableNameRefusal(name) ?? credentialValueRefusal(context, value)
    if (refusal) return fail(refusal)
    await context.workspaces.updateSettings(id, settings => ({ ...settings, env: { ...settings.env, [name]: value } }))
    process.stdout.write(`Workspace ${id}'s commands see ${name}.\n`)
    return { exitCode: 0, detail: `set ${id} env.${name}` }
  }
  const setting = settingKey(key)
  if (typeof setting === 'string') return fail(setting)
  await context.workspaces.updateSettings(id, settings => setting.set(settings, value))
  process.stdout.write(`Workspace ${id}: ${key} is set.\n`)
  return { exitCode: 0, detail: `set ${id} ${key} ${value}` }
}

async function unset(context: Context): Promise<CliResult> {
  const [key, ...extra] = context.rest
  if (!key || extra.length > 0) return fail('Usage: buckle workspace unset <key>')
  const id = context.workspaces.target({ ...context.target, cwd: context.cwd })
  if (key.startsWith('env.')) {
    const name = key.slice('env.'.length)
    await context.workspaces.updateSettings(id, (settings) => {
      const { [name]: _dropped, ...env } = settings.env
      return { ...settings, env }
    })
    process.stdout.write(`Workspace ${id}'s commands no longer see ${name}.\n`)
    return { exitCode: 0, detail: `unset ${id} env.${name}` }
  }
  const setting = settingKey(key)
  if (typeof setting === 'string') return fail(setting)
  await context.workspaces.updateSettings(id, settings => setting.unset(settings))
  process.stdout.write(`Workspace ${id}: ${key} is back to its default.\n`)
  return { exitCode: 0, detail: `unset ${id} ${key}` }
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

/** How many words a 0.1 `token` spelling takes, its workspace's id first. */
const LEGACY_POSITIONALS: Readonly<Record<string, number>> = { add: 1, list: 1, revoke: 2 }

/** `token create|list|revoke` on the target workspace, and the 0.1 spellings that name the workspace first, for one release. */
async function token(context: Context): Promise<CliResult> {
  const [action, ...words] = context.rest
  const { positionals, values } = parseArgs({ args: words, options: { label: { type: 'string' } }, allowPositionals: true })
  const flagged = context.target.workspace !== undefined || context.target.dir !== undefined
  const legacy = (count: number) => positionals.length === count && !flagged
  // A 0.1 spelling's id beside --workspace or --dir names two workspaces; minting for one of them would be a guess (finding 32).
  if (flagged && action !== undefined && positionals.length === LEGACY_POSITIONALS[action]) return fail(`Name the workspace once: buckle workspace token ${action} <id>${action === 'revoke' ? ' <token-id>' : ''}, the 0.1 spelling, or buckle workspace token ${action === 'add' ? 'create' : action}${action === 'revoke' ? ' <token-id>' : ''} --workspace <id>`)
  if (action === 'create' || action === 'add') {
    if (positionals.length > (action === 'add' ? 1 : 0)) return fail('Usage: buckle workspace token create [--label <text>]')
    const id = action === 'add' && legacy(1) ? positionals[0]! : context.workspaces.target({ ...context.target, cwd: context.cwd })
    const minted = await context.workspaces.addToken(id, { label: values.label })
    process.stdout.write(`Minted ${minted.id} for workspace ${id}

  agent token   ${minted.token}

Shown once. Revoke it with buckle workspace token revoke ${minted.id} --workspace ${id}.
`)
    return { exitCode: 0, detail: `token create ${id} ${minted.id}` }
  }
  if (action === 'list') {
    if (positionals.length > 1) return fail('Usage: buckle workspace token list')
    const id = legacy(1) ? positionals[0]! : context.workspaces.target({ ...context.target, cwd: context.cwd })
    return print(context.workspaces.listTokens(id))
  }
  if (action === 'revoke') {
    if (positionals.length < 1 || positionals.length > 2) return fail('Usage: buckle workspace token revoke <token-id>')
    const [id, tokenId] = legacy(2) ? [positionals[0]!, positionals[1]!] : [context.workspaces.target({ ...context.target, cwd: context.cwd }), positionals[0]!]
    if (!await context.workspaces.revokeToken(id, tokenId)) return fail(`Workspace ${id} holds no token ${tokenId}`)
    process.stdout.write(`Revoked ${tokenId}. Calls presenting it are refused from now on.\n`)
    return { exitCode: 0, detail: `token revoke ${id} ${tokenId}` }
  }
  return fail(USAGE)
}

/** The one id a verb names. */
function onlyId(words: readonly string[], verb: string): string {
  const [id, ...extra] = words
  if (!id || extra.length > 0) throw new WorkspaceError(`Usage: buckle workspace ${verb} <id>`)
  return id
}

function print(value: unknown): CliResult {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  return { exitCode: 0 }
}

function fail(message: string): CliResult {
  process.stderr.write(`${message}\n`)
  return { exitCode: 1 }
}
