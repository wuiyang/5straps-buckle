# Workspace settings, and moving from 0.1

Each [workspace](workspaces.md) of a node of Buckle, the approval and sandbox runtime on this
machine, keeps its settings in its own file, `workspaces/<id>/workspace.json` in the state
directory. The node keeps its own in `buckle.env`. This page lists both, says when a change
applies, and covers the move from 0.1.

## Settings

`buckle workspace show` prints a workspace's `workspace.json`: its policy, where the agent sees
its folder, its variables, packs, browser settings, and approval wait, and a revision counted
at each write. `buckle workspace set <key> <value>` and `unset <key>` change one
setting, checked whole with the rest before anything is written:

| Key | Takes | Default |
|---|---|---|
| `name` | the workspace's name, shown beside its id | the folder's name |
| `env.<NAME>` | a variable its shell commands see | none |
| `approvalWaitMs` | milliseconds a gated call waits for an answer; `0` waits until someone answers | `15000` |
| `packs.enabled` | the packs offered, comma separated, which leaves plugins out | every built-in pack, and plugins |
| `packs.shell` | `on` or `off`: the shell pack | on |
| `packs.code` | `on` or `off`: [code mode](code-mode.md) | on |
| `packs.hostGit` | `on` or `off`: the `git` and `forge` packs, which read the repository outside per-file checks | off |
| `packs.hostLsp` | `on` or `off`: language servers in the `dev` pack | off |

A variable name that looks like a credential (holding token, secret, password, or key) is taken,
with a warning that its value is plain text in `workspace.json` and reaches every command. A name
starting `BUCKLE_`, and the names Buckle sets for every command (`PATH`, `HOME`, `USER`,
`LOGNAME`, `SHELL`, and `TMPDIR`), are refused. So is a value that, after trimming, contains a
secret the node holds (the admin token, `BUCKLE_AUTH_TOKEN`, the forge token, the Brave search
key, the report token, the Rings pairing key, or the approval webhook's URL) or a workspace's
agent token as a word of it. Keep real secrets in your own store: `buckle workspace show` prints the file whole, and every
command in the workspace can read it. A call's own `env` is set over the workspace's variables.

The policy, its command, URL, interpreter, and tool lists, changes with `buckle policy`, which
acts on one workspace as every command does ([Policy](policy.md)). Where the agent sees the
folder changes with `buckle policy mount <path>` and `unmount`.

The browser settings (`browser.cdp`, `browser.profile`, `browser.args`, `browser.headed`, and
`browser.idleTimeoutMs`) are kept in the file but not read: the browser runs on the node's
`BUCKLE_BROWSER_*` settings until a later release reads each workspace's own; `buckle workspace
set` refuses them.

## When a change applies

A running `buckle serve` or `buckle mcp` watches a workspace's state folder and takes a change up
at once while the workspace is idle, with a check of `workspace.json` at the start of each call as
the fallback. A change to the policy lists, the variables, or the approval wait applies then; a
call already running keeps the rules it started with. A change to the packs or to where the folder shows waits until the workspace has no active
work, such as a running call or a shell copy awaiting review, and calls are refused with a 409
until then. A file that will not read leaves the settings in force, and the owner's log says so
once. `buckle serve` watches the registry folder the same way, with its poll as the fallback.

## Node settings

`buckle.env` holds what every workspace shares: the node's name and id, host and port, the admin
credential, the sandbox mode, logging, request and timeout limits, history and isolation budgets,
the experimental admin face, where programs such as `agent-browser` are, the browser settings,
`BUCKLE_ALLOWED_HOSTS`, and the [Rings](rings.md) pairing. `buckle settings show` lists
them; a change applies when the node restarts. `buckle settings set` refuses a
setting that belongs to a workspace now, naming the command that changes it, and `buckle
settings unset` removes its line. `BUCKLE_SHELL_NETWORK` and `BUCKLE_SHELL_ISOLATION` stay
node-level until Phase 2 of the workspace model moves them into each `workspace.json`.

## Moving a node from 0.1

The first command of this release on a state directory 0.1 used moves the node onto
workspaces, once, under the registry's lock:

- The folder the node served, `BUCKLE_WORKSPACE_ROOT` or the directory the command runs in,
  becomes a workspace named after its folder, with a UUID id Buckle assigns and its records under
  `workspaces/<id>/`. `BUCKLE_AUTH_TOKEN` becomes its token `node`, so agents configured with it
  keep working; `buckle workspace token create --workspace <that name>`, then `token revoke
  node`, rotates it.
- Each workspace registered with `buckle workspace add` keeps its 0.1 id as its name, gets a UUID
  id, and keeps its folder and tokens. A disabled or retired one is kept offline. Each
  workspace's own admin credential goes: the node's is the one.
- The registry keeps every token as its SHA-256 digest alone.
- The settings the environment held (the command, URL, and interpreter lists, the mount, the
  packs and their switches, the approval wait, and the browser settings) are copied into each
  workspace's `workspace.json`. The node's own folder's workspace also keeps the policy
  `buckle policy` stored.
  A registered workspace keeps exactly what the node enforced on it, its own lists within the
  node's; where no single list can say that, nothing changes, and the start is refused, naming
  the workspace and the lists to settle.
- Grants, remembered denials, and the dangerously-allow switch move from the folder they were
  kept under to the workspace's id.

A state directory that served nothing gets no workspace until `buckle init` makes one.

The move keeps owner-only copies of what it changes: `workspaces.v1.json` and
`policy.v1.json` in the state directory (empty where the node had no registry or policy), and
`grants.v1.json` and `dangerously-allow.v1.json` beside each grants and switch file it moved, in
`workspaces/<id>/` for every workspace. It makes `policy.json`
a version 2 stub and takes `BUCKLE_AUTH_TOKEN` out of `buckle.env`, so an older Buckle refuses to
start.

To go back to 0.1, stop Buckle and its MCP clients. Copy each `*.v1.json` file over its original,
set `BUCKLE_AUTH_TOKEN` in `buckle.env` to the token your agents use (Buckle kept only its
digest), and install the older release. Going back loses every workspace registered, token
created, grant, denial, and `workspace.json` written after the move.

`workspaces.v1.json` holds the registered workspaces' agent tokens and admin credentials in clear
text. Once the node works, delete every `*.v1.json` file in the state directory and in each
`workspaces/<id>/` folder; the way back goes with them.
