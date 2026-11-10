import { helpLines, MODES_HELP } from './dangerously-allow-words.js'

export const BROWSER_CLOSE_USAGE = `Usage: buckle browser close [--workspace <name>]
Closes every browser the workspace's agents left open, in every Buckle process on this machine, and drops the secret
values their pages hold. It needs no running node; a running node finds them gone at its next call.`

export const CHECK_URL_USAGE = `Usage: buckle check-url <url|host> [--session <id>] [--workspace <name> | --dir <path>]
Exits 0 approved, 1 denied, 3 asks, 4 not listed, 2 when no verdict could be reached.`

export const HISTORY_USAGE = 'Usage: buckle history list [--last <n>] | restore <id> | restore-stage <stage> <session> | recover <id> | prune [--legacy] [--force]'

export const KEYS_USAGE = `Usage:
  buckle keys enroll <public-key> --purpose setup|approval --workspace <name>|node [--label <text>]
                                                     Trust a person's client key for signed setup changes
                                                     or approval decisions, on one workspace or the whole
                                                     node (the registry needs node); one key, one purpose
  buckle keys list [--json]                          The enrolled keys with their scope, revoked ones included
  buckle keys revoke <key-id>                        Stop trusting a key, at once, and close its setup sessions
  buckle keys sessions                               The setup sessions keys hold open
  buckle keys node                                   This node's own public key, for a person's client to pin`

export const POLICY_USAGE = `Usage: buckle policy <action> [--workspace <name> | --dir <path>]
Acts on the workspace named, or else on the one whose folder holds the current directory.

  buckle policy show [--json]                 The workspace's policy, and its mount table
  buckle policy allow-command <glob>          Only matching command lines may run
  buckle policy deny-command <glob>           Matching command lines are refused; deny wins
  buckle policy destructive-command <glob>    Matching command lines ask first, once or per session
  buckle policy allow-interpreter <name>      Read calls of this interpreter (python3, node) as ordinary
                                              commands; any other runs code Buckle cannot read
  buckle policy remove-interpreter <name>     Read that interpreter as unknown again
  buckle policy allow-url <host|url-prefix>   Only listed hosts and URLs may be reached
  buckle policy mount <path> | unmount        Show the workspace to the agent as this path
  buckle policy deny-tool <tool>              Refuse this tool outright, whatever its pack allows
  buckle policy allow-tool <tool>             Lift that refusal; a tool in a withheld pack stays withheld
  buckle policy remove <pattern>              Drop a pattern from every list
  buckle policy import <file.json>            Replace the workspace's policy from a file
  buckle policy export                        Print the workspace's policy as JSON
  buckle policy clear                         Empty every list
  buckle policy dangerously-allow on|safe|off
${helpLines({ text: `DANGEROUS: allow asks in the workspace without a person, bound to the workspace root, or its mount when one is set; ${MODES_HELP}`, indent: 46, width: 98 })}

Exits 0 when done, 1 when the node refuses the change or the input, and 2 when the change conflicts
with the node's state (the refusals the setup face answers 409): active work, or a policy file that
names the dangerously-allow switch.

A command glob is matched one shell word at a time. 'pnpm {build,test} *' allows 'pnpm build'
with any arguments after it: * stands for one word, and a trailing * for the rest of the line.
An allow glob must cover the whole line; a deny glob covers every line starting with it.
`

export const WORKSPACE_USAGE = `Usage: buckle workspace <verb>. A verb that takes no name acts on the workspace --workspace <name> names, or
the one whose folder holds --dir <path>, or else the current directory. <name> is a workspace's name, or its id.

  buckle workspace init [--dir <path>] [--name <name>] [--volume <local>:<sandbox>[:ro]]... [--yes]
                                       Serve a folder as a workspace, and print its agent token once;
                                       each --volume shares another host folder or file, as mount add does
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
  buckle workspace mount add <local>:<sandbox>[:ro] [--read-only] | remove <sandbox> | list [--json]
                                       Share a host folder or file at a sandbox path, read-write unless :ro;
                                       take one away; list the table as source:target:access
  buckle workspace set <key> <value> | unset <key>
                                       Change one setting: name, env.<NAME>, or a key buckle workspace show lists
  buckle workspace token create [--label <text>] | list | revoke <token-id>
                                       Mint an agent token, shown once; list them; refuse one from now on
  buckle workspace judge-cache clear   Forget the decision AI's kept verdicts and Socket summaries

A name that another workspace holds is asked about at a terminal; with --yes, or none, the command is refused.
`

export const INIT_USAGE = `Usage: buckle init [--dir <dir>] [--mount <path>] [--volume <local>:<sandbox>[:ro]]... [--name <name>] [--port <n>]
                  [--out <file>] [--yes] [--force]

Sets this machine's node up once, then serves a folder as one of its workspaces: the current directory, or --dir
(--root is its earlier name), seen by the agent at /workspace, or at --mount. Each --volume shares another host
folder or file at a sandbox path, read-write unless :ro, as buckle workspace mount add does; a folder a workspace
serves already takes none here, and mount add adds to that workspace. --name names the node.

The node's settings go to buckle.env in the state directory (~/.5straps/buckle, or BUCKLE_STATE_DIR), owner-only;
--out or BUCKLE_ENV_FILE selects a custom file instead, which buckle mcp reads only inside the state directory. They
hold its name, host, port and admin credential, and a node already set up keeps them unless --force writes them
again. The workspace's own settings go to its workspace.json. In a terminal, init asks for the folder, more folders
to mount, which packs to offer, the shell, host Git, and the approved hosts; --yes, or no terminal, takes the
defaults and the --volume mounts alone, and says what it kept. Change them later with buckle workspace set,
buckle workspace mount, and buckle policy. The workspace's agent token is printed once; buckle workspace token create
mints more.
`

export const CLIENT_USAGE = `Usage:
  buckle client keygen [--force]      Make this device's signing key; prints the public key to enroll
  buckle client key                   Print this device's public key and its fingerprint
  buckle client request <METHOD> <url> [--body <json>] [--purpose setup|approval] [--node <server-id>] [--session <id>]
                                      Send one request to a pinned node's setup face, signed with this device's key;
                                      --node, when given, must name the node pinned for the URL
  buckle client session open <node-url> [--workspace <name>]
  buckle client session close <node-url> <session-id> [--workspace <name>]
                                      A setup session: signed setup changes name it with --session
  buckle client trust <node-url> <server-id> <node-public-key>
                                      Pin the node at that URL, as \`buckle keys node\` prints it on that node
  buckle client approvals <node-url> --workspace <name>
  buckle client approve <node-url> <token> [--deny] [--scope once|session|always] [--below] --workspace <name>
                                      Show the whole action an ask is, as the pinned node signed it, and decide on exactly that;
                                      --below grants a delete's folder and its subfolders, for the session or always, where the
                                      ask offers them

--ignore-warning asks the node to make a change its audit log cannot record (ignoreWarning=true in the signed query);
without it the node refuses the change, 503, and the command prints the write's error and exits 6.

The key and the pinned nodes live in BUCKLE_CLIENT_DIR (an absolute path), ~/.5straps/client by default, owner-only.
A request is signed only for the node pinned for the URL typed, never for what the URL says it is.`

export const COPY_USAGE = `Usage: buckle cp <from> <to> [--node <url>] [--token-file <file>]

Copies one file between this machine and a workspace on a Buckle node. The bytes go over the node's HTTP face, never
through an agent, and the node judges each copy as it judges fs_write and fs_read: a copy that needs a person waits
here until it is approved at the node, or denied, sent again under the same request; Ctrl-C stops it.

  <path> or local:<path>     a file on this machine
  <workspace>:<path>         a file in that workspace, by its name or id; <path> as fs_write takes it there,
                             relative to the workspace's folder or under its mount such as /workspace;
                             <workspace>: alone is the workspace's folder

  A slash before the first colon keeps an end on this machine (./notes:2026.txt). On Windows, C:\\ or C:/ is a
  drive here, so a workspace named with one letter is written by its id. A workspace whose name holds a colon is
  written by its id too. A <to> that is a folder takes the file's own name; a <to> whose folder does not exist is
  refused, as no folder is made. Two files on this machine: use cp. Two workspaces: not yet, as a token opens one
  workspace; copy the file out to this machine, then into the other. Workspaces on two nodes: not yet.

  --node <url>        The node, such as http://127.0.0.1:4320; else BUCKLE_NODE_URL; else the node buckle serve runs here
  --token-file <file> An owner-only file with a BUCKLE_AUTH_TOKEN=<token> line, the workspace's agent token; else
                      BUCKLE_AUTH_TOKEN. The token is never taken from the command line.

Exits 0 once copied, 1 when the node or the copy refuses, 2 on a command line it cannot read.
`

export const SERVICE_USAGE = `Usage: buckle service install [--now] | uninstall | start | stop | restart | status [--json] | logs [-f] [-n <lines>]

Runs this machine's node with no terminal, starting at login: a systemd user unit on Linux, a launchd agent on
macOS, a Task Scheduler task on Windows (docs/user/how-to/service.md). One node per machine. install writes the
definition and enables it, and --now starts it too; --skip-owner-only-check on install is kept in the definition.
uninstall stops it and removes the definition, keeping the state directory. Where no service manager answers,
buckle serve --background runs the node until it stops, and stop, status, and logs work on that node too.
`

/**
 * The queue a person answers from. `buckle approve` needs a token, and a request only reaches a
 * terminal when a prompt was on screen there, so without this the tokens waiting on a node were
 * readable through the admin API alone.
 */
export const APPROVALS_USAGE = 'Usage: buckle approvals [--json] [--watch] [--workspace <name> | --all], buckle approvals show <token> [--json] [--workspace <name> | --all], or buckle approvals judge <token> [--approve-if-safe] [--workspace <name> | --all]'

/**
 * Decides one ask at the node. Owner decision D17: the whole action is printed first, as `buckle approvals`
 * shows it, and an approval is recorded only after the person at a terminal confirms it. Without a terminal
 * nothing is approved (a denial still is), and an ask recorded before this build, whose whole call was never
 * kept, can only be denied (review H2).
 */
export const APPROVE_USAGE = "Usage: buckle approve <token> [--scope once|session|always] [--host '*.example.com' | --below] [--deny] [--workspace <name> | --all]"

export const GRANTS_USAGE = 'Usage: buckle grants | grants revoke <id>\nLists the standing grants, or revokes one by its id.'

export const PLUGIN_USAGE = 'Usage: buckle plugin | plugin add <id> <module-specifier> | plugin remove <id>\nLists the plugins, adds one, or removes one.'

export const WORKSPACES_USAGE = 'Usage: buckle workspaces list | inspect <id> | publish <id> | discard <id> | prune'

/** Whether a command line is the owner's `buckle browser close`, never a browser tool, which `buckle browser command` runs. */
export function isBrowserClose(command: string, argv: readonly string[]): boolean {
  return command === 'browser' && argv[0] === 'close'
}
