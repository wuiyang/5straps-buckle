import { INIT_USAGE as USAGE } from './usage.js'
import type { CliResult } from './result.js'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { dirname, resolve } from 'pathe'
import { parseArgs } from 'node:util'
import { MountPathSchema } from '@5straps/protocol'
import { defaultEnvironmentFile, environmentFilePath, loadConfig, stateDirectoryOf, WORKSPACE_DEFAULT_KEYS, workspaceHolds, type NodeConfig } from '../common/runtime/config.js'
import { realPathOf } from '../common/runtime/real-path.js'
import { recordEnvironmentFile } from '../common/runtime/environment-files.js'
import { buckleVariables } from '../common/runtime/environment.js'
import { AS_NAMED, findProgram, ON_PATH, type ProgramSearch, type UntrustedRoots } from '../common/domain/executable.js'
import { isDriveRoot, typedPath, WHOLE_DRIVE } from '../common/domain/paths.js'
import { refusedNetworkEntries } from '../common/domain/policy.js'
import { BROWSER_INSTALL } from '../common/services/packs/browser/metadata.js'
import { BUILTIN_PACKS, unmetPackPrerequisite } from '../common/services/packs/catalogue.js'
import { nodeRootsOf, openWorkspaceManager, servingWorkspace, type MintedToken, type WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import { WorkspaceError } from '../common/domain/workspace-error.js'
import { MigrationError, movedOntoWorkspaces } from '../common/services/workspaces/migration.js'
import { workspaceUntrusted } from '../common/services/workspaces/node-roots.js'
import { mountRows, resolveSettings, withMount, withOwnerMounts, type ResolvedSettings, type WorkspaceSettings } from '../common/services/workspaces/workspace-settings.js'
import { mountGuardsOf } from '../common/services/workspaces/workspace-dirs.js'
import { formatMountRow, parseMountSpec, type MountRow, type OwnerMount } from '../common/domain/mount-table.js'
import { editEnvironmentVariable, writeEnvironmentFile } from '../common/adapters/environment-file.js'
import { workspaceArgument } from '../common/domain/approval-instruction.js'
import { findNodeSetting, NODE_SETTINGS, normaliseSetting } from './node-settings.js'
import { checkedVolumes, createNamed, unnamedMount } from './workspace.js'
import { serviceInstalled } from '../common/services/node-service/installed.js'
import { drivesServiceManager } from '../common/adapters/service-manager/index.js'
import { attachCommand } from '../common/services/node-service/attach.js'
import { runningNode, type RunningNode } from '../common/services/node-service/serve-record.js'
import { homeDirectory } from '../common/domain/paths.js'
import { wordList } from '../common/domain/word-list.js'



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
 * it: a default grants an agent nothing an unedited install would not. One left unanswered stays unset in the
 * workspace's settings, so the node's value stands for it, else Buckle's (D85, Q3).
 */
export interface WorkspaceChoices {
  /** A list names the packs, which drops plugins. */
  packs?: string[]
  shell?: boolean
  hostGit?: boolean
  networkAllow?: string[]
}

const DEFAULT_CHOICES: WorkspaceChoices = {}

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
      dir: { type: 'string' }, root: { type: 'string' }, mount: { type: 'string' }, volume: { type: 'string', multiple: true }, name: { type: 'string' }, port: { type: 'string' }, out: { type: 'string' },
      yes: { type: 'boolean' }, force: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  })
  if (values.help) {
    process.stdout.write(USAGE)
    return { exitCode: 0 }
  }

  const out = values.out ? resolve(values.out) : environmentFilePath()
  const writesNode = !existsSync(out) || values.force === true
  const interactive = prompt.interactive && !values.yes
  const given = values.dir ?? values.root
  let answers: { folder: string; mount: string | null; volumes: string[]; name: string | null; allowedHosts: string | null }
  let choices = DEFAULT_CHOICES
  try {
    // Under --yes, or with no terminal, the --volume mounts alone: a default install adds none (D83).
    answers = interactive
      ? await askFolder(prompt, { folder: given, mount: values.mount, name: values.name, writesNode, served: asked => servedFolder({ out, folder: asked, platform }) !== null })
      : { folder: given ?? process.cwd(), mount: values.mount ?? '/workspace', volumes: [], name: values.name ?? null, allowedHosts: null }
    if (interactive) {
      choices = await askWorkspaceChoices(prompt)
      if (writesNode) answers.allowedHosts = await askValid(prompt, `Hosts a workspace with no approved list of its own may reach, which turns that list on (other hosts are refused; a host named exactly may be private), e.g. db.internal [${earlierHosts(out) ?? 'none'}]: `, raw => nodeSettingValue('BUCKLE_ALLOWED_HOSTS', raw))
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
  // Read before anything changes, so a default it cannot carry refuses init with nothing written.
  const carried = writesNode && existsSync(out) ? carriedDefaults(out, answers.allowedHosts === null ? [] : ['BUCKLE_ALLOWED_HOSTS']) : { keys: [], into: (text: string) => text }
  if ('exitCode' in carried) return carried
  const fromEnvironment = !existsSync(out) && !movedOntoWorkspaces(stateDirectoryOf(process.env, platform)) ? carriedFromEnvironment(out) : { keys: [], into: (text: string) => text }
  if ('exitCode' in fromEnvironment) return fromEnvironment
  const adminToken = writesNode ? credential() : null
  const written = adminToken ? fromEnvironment.into(carried.into(renderNode({ name, port, adminToken, allowedHosts: answers.allowedHosts }))) : null
  // Each mount named is checked as buckle workspace mount add checks one, on the node the file will set up, so a refused
  // one stops init before anything is written (the workspace-model follow-up, M3).
  const volumes = [...values.volume ?? [], ...answers.volumes]
  // A folder a workspace serves takes no mount here, so it is looked up before the mounts are checked against a folder
  // that is not the workspace's own: init refuses the request instead of dropping it (the mounts follow-up, first fix round).
  const holder = volumes.length > 0 ? servedFolder({ out, folder, platform }) : null
  if (holder !== null) return fail(`The folder is already served by workspace ${holder.name}; add mounts with buckle workspace mount add <local>:<sandbox>[:ro] --workspace ${workspaceArgument(holder.name)}. Nothing was written.`)
  let mounts: OwnerMount[] = []
  if (volumes.length > 0) {
    try { mounts = checkedVolumes(volumes, { cwd: process.cwd(), dir: folder, folder: mount, guards: mountGuardsOf(nodeConfig(out, written ?? readFileSync(out, 'utf8'), platform), platform) }) } catch (error) {
      if (error instanceof WorkspaceError) return fail(error.message)
      throw error
    }
  }
  if (writesNode && existsSync(out)) {
    const refused = await moveFromOwnFile(out, platform, interactive ? question => prompt.question(question) : undefined)
    if (refused) return refused
  }
  if (written !== null) {
    // The state directory holds the node's credentials, so it is created owner-only (ruling 7).
    if (out === defaultEnvironmentFile()) mkdirSync(dirname(out), { recursive: true, mode: 0o700 })
    writeEnvironmentFile(out, written)
  }
  const contents = readFileSync(out, 'utf8')
  const node = nodeConfig(out, contents, platform)
  mkdirSync(node.stateDirectory, { recursive: true, mode: 0o700 })
  // Every Buckle process on this state directory keeps the file from tools, a buckle mcp whose environment names none too.
  await recordEnvironmentFile({ stateDirectory: node.stateDirectory, file: out })
  let workspaces: WorkspaceManager
  try { workspaces = await openWorkspaceManager({ config: node, platform, ...(interactive ? { askName: question => prompt.question(question) } : {}) }) } catch (error) {
    if (error instanceof WorkspaceError || error instanceof MigrationError) return fail(error.message)
    throw error
  }
  try {
    const served = await serveFolder({ workspaces, folder, mount, mounts, choices, prompt: { ...prompt, interactive } })
    const nodePort = /^BUCKLE_PORT=(\d+)$/m.exec(contents)?.[1] ?? port
    const start = await startOf(node.stateDirectory, platform, options.home)
    const inForce = resolveSettings(workspaces.settings(served.id), node.workspaceDefaults)
    // Left for a node that moved onto workspaces just now: its folder was served by the move, which the lookup before could not see.
    const unadded = mounts.length > 0 ? ` The mounts named were not added either; add them with buckle workspace mount add <local>:<sandbox>[:ro] --workspace ${workspaceArgument(served.name)}.` : ''
    process.stdout.write(`${adminToken ? `Wrote ${out}` : `The node is already set up in ${out}; its settings are unchanged.`}
${served.token ? '' : `\n${folder} is already in workspace ${served.name}: nothing was added. Mint a token for it with buckle workspace token create --workspace ${workspaceArgument(served.name)}.${unadded}\n`}
  Workspace   ${served.name} at ${folder}
  Seen as     ${served.created ? (mount ?? folder) : '(as it was)'}
${adminToken ? `  Node name   ${name}\n` : ''}${carried.keys.length > 0 ? `  Kept        ${carried.keys.join(', ')}, every workspace's defaults, from the file written again\n` : ''}${fromEnvironment.keys.length > 0 ? `  Carried     ${wordList(fromEnvironment.keys)}, from this command's environment, where this node set up before workspaces held ${fromEnvironment.keys.length === 1 ? 'it' : 'them'}, for its move onto workspaces\n` : ''}${served.created ? describeChoices(inForce) : ''}${describeMounts(mountRows(workspaces.lookup(served.id)!.dir, inForce))}${served.created && !interactive ? `These are the defaults, kept because nothing was asked${mounts.length > 0 ? ', beside the mounts --volume named' : ''}. Change one with: buckle workspace set <key> <value>\n` : ''}
${describePrograms({ node, folder, platform, search: options.programSearch ?? {} })}

Next:
${startSteps(start, { out, platform, stateDirectory: node.stateDirectory })}
${served.token ? `  2. Give an agent this workspace's token, shown once; it reaches /mcp and /v1 at http://127.0.0.1:${nodePort}:
       agent token        ${served.token.token}
` : ''}${adminToken ? `     The node's admin credential, for the experimental /setup face:
       admin credential   ${adminToken}
` : ''}${hintStep('  3. Restrict it:', restrictCommands(platform))}

The agent token runs tools in this workspace alone. The admin credential reads and pushes a workspace's policy at
/setup, mints and revokes workspace tokens, and nothing else; keep them apart. /setup is experimental and off until you
switch it on: buckle settings set experimental-admin-http on
`)
    return { exitCode: 0 }
  } catch (error) {
    if (error instanceof WorkspaceError) return fail(error.message)
    throw error
  } finally {
    await workspaces.close()
    prompt.close()
  }
}

/**
 * What starts the node, read where init prints a hint (fix brief 6, item 11): a node running now already serves a workspace
 * added to its registry (Q2), and `buckle serve` beside one is refused (Q5), so the hint says so; an installed service is
 * started with `buckle service start`; with neither, `buckle serve`, and the install offer where the platform has a service.
 */
type NodeStart = { kind: 'running'; running: RunningNode } | { kind: 'service' } | { kind: 'serve' }

async function startOf(stateDirectory: string, platform: NodeJS.Platform, home: string | undefined): Promise<NodeStart> {
  const running = await runningNode(stateDirectory).catch(() => null)
  if (running !== null) return { kind: 'running', running }
  return serviceInstalled(stateDirectory, process.env, platform, home ?? homeDirectory(platform)) ? { kind: 'service' } : { kind: 'serve' }
}

/** The first step of Next, and the install offer where it still applies. */
function startSteps(start: NodeStart, input: { out: string; platform: NodeJS.Platform; stateDirectory: string }): string {
  if (start.kind === 'running') {
    const { record } = start.running
    const pid = record === null ? '' : ` (pid ${record.pid})`
    return record?.manager === 'terminal'
      ? `  1. The node runs at a terminal${pid} and serves this workspace now; no restart is needed.\n     Its approvals are answered there.`
      : `  1. The node runs in service mode${pid} and serves this workspace now; no restart is needed.\n     Answer its approvals here with: ${attachCommand(input.stateDirectory, process.cwd(), input.platform)}`
  }
  if (start.kind === 'service') return hintStep('  1. Start the node:', serveCommand(input.out, process.env, input.platform, 'buckle service start'))
  const offer = drivesServiceManager(input.platform) ? `\n${hintStep('     Or at every login:', serveCommand(input.out, process.env, input.platform, 'buckle service install --now'))}` : ''
  return `${hintStep('  1. Start the node:', serveCommand(input.out, process.env, input.platform))}${offer}`
}

/**
 * `--force` on a node set up before workspaces moves it from the file it is about to replace (fix brief 1, A4, findings
 * 11 and 21): the node folder's workspace keeps its 0.1 folder, token, policy, and grants, which the rewritten file no longer
 * names. A file that will not load is left for --force to rewrite once the node has moved; before, it is refused.
 */
async function moveFromOwnFile(out: string, platform: NodeJS.Platform, askName?: (question: string) => Promise<string>): Promise<CliResult | null> {
  let node: NodeConfig
  try { node = nodeConfig(out, readFileSync(out, 'utf8'), platform) } catch (error) {
    if (movedOntoWorkspaces(stateDirectoryOf(process.env, platform))) return null
    return fail(`buckle init --force moves this node onto workspaces from ${out} before it writes the file again, and ${out} will not load: ${error instanceof Error ? error.message : String(error)}. Repair that line, then run buckle init --force again.`)
  }
  if (movedOntoWorkspaces(node.stateDirectory)) return null
  mkdirSync(node.stateDirectory, { recursive: true, mode: 0o700 })
  try { await (await openWorkspaceManager({ config: node, platform, ...(askName ? { askName } : {}) })).close() } catch (error) {
    if (error instanceof WorkspaceError || error instanceof MigrationError) return fail(error.message)
    throw error
  }
  return null
}

/**
 * The node's workspace defaults the file `--force` writes again held (D85, Q3): init asks for one of them, the node's
 * hosts, and its deny lists are a floor over every workspace (Q14), so the new file keeps each, every one of
 * WORKSPACE_DEFAULT_KEYS, a command list written with `;;` between its globs, as the node reads one. A key this run
 * `answered` is the owner's new value, so it is neither written over nor listed as kept; the hosts question shows the
 * old value as its default (`earlierHosts`), so Enter keeps it and an answer replaces it. One that cannot be carried
 * refuses init before anything changes.
 */
function carriedDefaults(out: string, answered: string[]): { keys: string[]; into: (text: string) => string } | CliResult {
  const values = Object.fromEntries(buckleVariables(readFileSync(out, 'utf8')))
  const keys = [...new Set([...NODE_SETTINGS.filter(setting => setting.workspace).map(setting => setting.key), ...WORKSPACE_DEFAULT_KEYS])]
  // An empty standard-scripts list names none, where unset brings back Buckle's built-in list, so it is kept empty.
  const emptyKept = (key: string) => findNodeSetting(key)?.kind === 'script-list' && values[key] !== undefined
  const kept = keys.filter(key => (values[key]?.trim() || emptyKept(key)) && !answered.includes(key))
    .map(key => ({ key, value: ['command-list', 'script-list'].includes(findNodeSetting(key)?.kind ?? '') ? commandList(values[key]!) : values[key]!.trim() }))
  return carriedInto({ kept, heading: 'Every workspace\'s defaults, kept from the file this one replaced (buckle settings show lists them).',
    refusal: reason => `buckle init --force keeps the node's workspace defaults, and cannot carry one as ${out} writes it: ${reason}. Set it with buckle settings set, then run buckle init --force again.` })
}

/** The hosts the file `--force` writes again holds, which the hosts question offers as its default; null when it holds none. */
function earlierHosts(out: string): string | null {
  if (!existsSync(out)) return null
  try { return Object.fromEntries(buckleVariables(readFileSync(out, 'utf8'))).BUCKLE_ALLOWED_HOSTS?.trim() || null } catch { return null }
}

/**
 * What a node set up before workspaces held in its environment, with no file, and its move onto workspaces read from
 * there (fix brief 6, item 9): the agent token line as 0.1 held it, the folder, and the deny and destructive lists. On a
 * node with no file that has not moved, init writes each into the file it makes, so the move reads them from the file
 * as it reads a file node's, and nothing the node enforced or served is dropped. The values are never printed.
 */
const ENVIRONMENT_CARRIED = ['BUCKLE_AUTH_TOKEN', 'BUCKLE_WORKSPACE_ROOT', 'BUCKLE_COMMAND_DENY', 'BUCKLE_COMMAND_DESTRUCTIVE'] as const

function carriedFromEnvironment(out: string): { keys: string[]; into: (text: string) => string } | CliResult {
  const kept = ENVIRONMENT_CARRIED.filter(key => process.env[key]?.trim())
    .map(key => ({ key, value: findNodeSetting(key)?.kind === 'command-list' ? commandList(process.env[key]!) : process.env[key]! }))
  return carriedInto({ kept, heading: 'Kept from the environment this node set up before workspaces ran in, which its move onto workspaces reads here.',
    refusal: reason => `buckle init carries this node's earlier settings from its environment into ${out}, and cannot write one as it holds it: ${reason}. Nothing was written.` })
}

/** A command list as the node reads one: its globs, trimmed, with `;;` between them. */
function commandList(value: string): string {
  return value.split(/\r?\n|;;/).map(item => item.trim()).filter(Boolean).join(';;')
}

/** Settings written under a heading at the end of the text init renders; one the file cannot hold refuses init first. */
function carriedInto(input: { kept: Array<{ key: string; value: string }>; heading: string; refusal: (reason: string) => string }): { keys: string[]; into: (text: string) => string } | CliResult {
  const into = (text: string): string => input.kept.reduce((written, { key, value }) => {
    const edit = editEnvironmentVariable({ text: written, name: key, value })
    if (!edit.ok) throw new Error(`${edit.reason}`)
    return edit.text
  }, `${text}\n# ${input.heading}\n`)
  try { into('') } catch (error) {
    return fail(input.refusal(error instanceof Error ? error.message : String(error)))
  }
  return { keys: input.kept.map(item => item.key), into: text => (input.kept.length === 0 ? text : into(text)) }
}

/**
 * The workspace already serving `folder`, read from the registry beside the node file `out` before anything is written
 * (the mounts follow-up, first fix round). None where there is no file yet, the file will not load (--force moves the
 * node from it before it writes), the node is not on workspaces yet, or its registry will not read; that last one is
 * not logged here, since opening the node reports it later.
 */
function servedFolder(input: { out: string; folder: string; platform: NodeJS.Platform }): { id: string; name: string } | null {
  if (!existsSync(input.out)) return null
  const dir = typedPath(input.folder, input.platform)
  let stateDirectory: string
  try { stateDirectory = nodeConfig(input.out, readFileSync(input.out, 'utf8'), input.platform).stateDirectory } catch { return null }
  try { return servingWorkspace({ stateDirectory, dir, platform: input.platform }) } catch (error) {
    if (error instanceof WorkspaceError) return null
    throw error
  }
}

/**
 * The folder as a workspace: a new one, named after the folder, with the choices as its settings, or the one already
 * holding it, which keeps its own. A name another workspace holds is asked about at a terminal (D85, Q15); with --yes,
 * or none, init is refused, naming the command that takes --name.
 */
async function serveFolder(input: { workspaces: WorkspaceManager; folder: string; mount: string | null; mounts: readonly OwnerMount[]; choices: WorkspaceChoices; prompt: InitPrompt }): Promise<{ id: string; name: string; created: boolean; token: MintedToken | null }> {
  let holder: string | null = null
  try { holder = input.workspaces.target({ cwd: input.folder }) } catch (error) {
    if (!(error instanceof WorkspaceError)) throw error
  }
  if (holder !== null) return { id: holder, name: input.workspaces.lookup(holder)!.name, created: false, token: null }
  const { workspace, token } = await createNamed(input.prompt, { yes: !input.prompt.interactive, refusal: 'name it with buckle workspace init --dir <folder> --name <name>' }, name => input.workspaces.create({ dir: input.folder, ...(name === undefined ? {} : { name }), label: 'buckle init', settings: settings => withChoices(settings, input.choices, input.mount, input.mounts) }))
  return { id: workspace.id, name: workspace.name, created: true, token }
}

/** The answers given as the workspace's own settings, the mounts checked already beside the folder's; an unanswered one stays unset. */
function withChoices(settings: WorkspaceSettings, choices: WorkspaceChoices, mount: string | null, mounts: readonly OwnerMount[]): WorkspaceSettings {
  const chosen = withMount({
    ...settings,
    packs: { ...settings.packs, ...(choices.packs ? { enabled: choices.packs } : {}), ...(choices.shell === undefined ? {} : { shell: choices.shell }), ...(choices.hostGit === undefined ? {} : { hostGit: choices.hostGit }) },
    policy: { ...settings.policy, network: { allow: choices.networkAllow ?? [] } },
  }, mount)
  return mounts.length === 0 ? chosen : withOwnerMounts(chosen, mounts, mount)
}

async function askFolder(prompt: InitPrompt, defaults: { folder?: string; mount?: string; name?: string; writesNode: boolean; served: (folder: string) => boolean }) {
  const folder = (await prompt.question(`Folder to serve [${defaults.folder ?? process.cwd()}]: `)).trim() || defaults.folder || process.cwd()
  const mount = (await prompt.question(`Where the agent sees it [${defaults.mount ?? '/workspace'}]: `)).trim() || defaults.mount || '/workspace'
  // A folder a workspace serves takes no mount here, so the question is not asked (the mounts follow-up, first fix round).
  const volumes = defaults.served(folder) ? [] : await askVolumes(prompt)
  const name = defaults.writesNode ? (await prompt.question(`Name for this node [${defaults.name ?? defaultNodeName(resolve(folder))}]: `)).trim() || defaults.name || null : null
  return { folder, mount, volumes, name, allowedHosts: null as string | null }
}

/**
 * The mounts beside the folder, one a question, after Docker's -v (Q6), until a blank answer. One that names no mount
 * is asked again, saying why; the rest of `buckle workspace mount add`'s checks run on them all before anything is
 * written (checkedVolumes).
 */
async function askVolumes(prompt: InitPrompt): Promise<string[]> {
  const volumes: string[] = []
  for (;;) {
    const answer = (await prompt.question('Mount another folder? local:sandbox[:ro], blank for none: ')).trim()
    if (!answer) return volumes
    if (parseMountSpec(answer, false)) volumes.push(answer)
    else prompt.say(unnamedMount(answer))
  }
}

/** The mount table as `buckle workspace mount list` prints it, the summary's last part (the workspace-model follow-up, M3). */
function describeMounts(rows: readonly MountRow[]): string {
  const [first, ...rest] = rows.map(formatMountRow)
  return `  Mounts      ${first ?? '(none)'}\n${rest.map(line => `              ${line}\n`).join('')}`
}

async function askWorkspaceChoices(prompt: InitPrompt): Promise<WorkspaceChoices> {
  prompt.say('\nPacks this workspace offers:')
  for (const pack of BUILTIN_PACKS) prompt.say(`  ${pack.id.padEnd(12)} ${pack.summary}`)
  const packs = await askValid(prompt, 'Packs to offer, comma separated; naming them turns plugins off [all]: ', packList)
  const shell = await askYesNo(prompt, 'Shell tools on? [Y/n]: ')
  prompt.say('Host Git and forge tools read the repository outside the sandbox\'s per-file checks, so they start off.')
  // D1, M5: a command's checkpoint is read through host Git, so the question says what turning it off costs.
  prompt.say('Change history needs host Git to restore what a command changes; a file tool\'s changes restore without it.')
  const hostGit = await askYesNo(prompt, 'Host Git and forge tools on, which command checkpoints need? [y/N]: ')
  const networkAllow = await askValid(prompt, 'Approved hosts and URLs, the only ones fetches and pages may reach, e.g. localhost:3000,*.example.com [none]: ', urlList)
  return { ...(packs === null ? {} : { packs: packs.split(',') }), ...(shell === undefined ? {} : { shell }), ...(hostGit === undefined ? {} : { hostGit }), ...(networkAllow === null ? {} : { networkAllow: networkAllow.split(',') }) }
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

/** The new workspace's settings in force: its answers, else the node's, else Buckle's. */
function describeChoices(settings: ResolvedSettings): string {
  return `  Packs       ${settings.packs.enabled?.join(', ') ?? 'all, and plugins'}
  Shell       ${settings.packs.shell ? 'on' : 'off'}
  Host Git    ${settings.packs.hostGit ? 'on' : 'off'}
  Network     ${settings.policy.network.allow.join(',') || 'no approved list'}
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
# credential, every workspace's. /setup is experimental and served only with
# BUCKLE_EXPERIMENTAL_ADMIN_HTTP=true (buckle settings set experimental-admin-http on).
BUCKLE_ADMIN_TOKEN=${input.adminToken}

# The state directory is where this file lives by default; move it with BUCKLE_STATE_DIR in the shell.
# BUCKLE_STATE_DIR=
BUCKLE_SANDBOX=auto
# Hosts a workspace with no approved list of its own may reach, which turns that list on: other hosts are refused, and
# a host named exactly may resolve to a private address.
${input.allowedHosts ? `BUCKLE_ALLOWED_HOSTS=${input.allowedHosts}` : '# BUCKLE_ALLOWED_HOSTS=db.internal'}

# Where this node reports what it did, and where a request waiting for a decision is announced.
# Set the report URL and token together; the token goes as a bearer to the report URL and the webhook.
# BUCKLE_REPORT_URL=
# BUCKLE_REPORT_TOKEN=
# BUCKLE_APPROVAL_WEBHOOK=
`
}

/** A hint's command lines as one shell reads them; `shell` names it where the platform has more than one. */
export interface ShellForm { shell: string | null; lines: string[] }

/**
 * How `buckle serve`, or `command`, finds the file just written: on its own from the default state directory, with
 * the state directory named when BUCKLE_STATE_DIR moved it, and by name for any other file. The
 * variable is set as the platform's shell sets one: before the command on Linux and macOS, and on
 * Windows in PowerShell's form and in cmd's, each its own; cmd's is quoted whole, or the space before
 * `&&` would end the value.
 */
export function serveCommand(out: string, environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, command = 'buckle serve'): ShellForm[] {
  const setting = out !== defaultEnvironmentFile(environment) ? { name: 'BUCKLE_ENV_FILE', value: out }
    : environment.BUCKLE_STATE_DIR ? { name: 'BUCKLE_STATE_DIR', value: dirname(out) } : null
  if (!setting) return [{ shell: null, lines: [command] }]
  const { name, value } = setting
  if (platform !== 'win32') return [{ shell: null, lines: [`${name}=${value} ${command}`] }]
  return [
    { shell: 'PowerShell', lines: [`$env:${name} = '${value.replaceAll("'", "''")}'; ${command}`] },
    { shell: 'cmd', lines: [`set "${name}=${value}" && ${command}`] },
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
const HINT_INDENT = '       '
const SHELL_LABEL_WIDTH = 13

/**
 * A hint: one form follows its label on the same line, its further lines aligned beneath; several forms each go
 * on lines of their own below the label, each labelled with its shell.
 */
function hintStep(label: string, forms: ShellForm[]): string {
  const [only] = forms
  if (forms.length === 1 && only!.shell === null) return `${label.padEnd(HINT_COLUMN)}${only!.lines.join(`\n${' '.repeat(HINT_COLUMN)}`)}`
  const labelled = forms.flatMap(form => form.lines.map((line, index) => `${HINT_INDENT}${(index === 0 ? form.shell ?? '' : '').padEnd(SHELL_LABEL_WIDTH)}${line}`))
  return [label, ...labelled].join('\n')
}

/** Questions on stderr, so stdout stays the summary; the readline is opened when one is asked, and again after a close. */
function terminalPrompt(): InitPrompt {
  let readline: ReturnType<typeof createInterface> | null = null
  return {
    interactive: Boolean(process.stdin.isTTY),
    question: text => (readline ??= createInterface({ input: process.stdin, output: process.stderr })).question(text),
    say: text => void process.stderr.write(`${text}\n`),
    close: () => { readline?.close(); readline = null },
  }
}

/** Yes or no; undefined where Enter keeps the default, which the workspace then leaves unset. */
async function askYesNo(prompt: InitPrompt, text: string): Promise<boolean | undefined> {
  for (;;) {
    const answer = (await prompt.question(text)).trim().toLowerCase()
    if (!answer) return undefined
    if (['y', 'yes', 'on', 'true'].includes(answer)) return true
    if (['n', 'no', 'off', 'false'].includes(answer)) return false
    prompt.say('Answer y or n, or press Enter for the default.')
  }
}

/** A program `buckle init` checks, by the name it is looked up by, with what it unlocks as docs/user/quick-start/install.md words it. */
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
    // fs_search_content runs without it, on Buckle's own slower walker (the fs-verbs brief).
    { label: 'rg', name: 'rg', unlocks: 'a faster fs_search_content, which Buckle runs with its own walker without it' },
    { label: 'git', name: 'git', unlocks: 'the git and forge packs, once host Git is turned on' },
    { label: 'agent-browser', name: config.agentBrowserCommand, unlocks: 'the browser pack', install: BROWSER_INSTALL, setting: 'BUCKLE_AGENT_BROWSER_COMMAND' },
  ]
  const search = { ...input.search, platform: input.platform, ...workspaceUntrusted({ root: realPathOf(input.folder, input.platform), scratchRoots: (config.workspaceDefaults.mounts ?? []).filter(mount => mount.access === 'rw').map(mount => mount.source) }, nodeRootsOf(config, input.platform)) }
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
