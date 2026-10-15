# Workspace settings, and moving from 0.1

Each [workspace](workspaces.md) of a node of Buckle, the approval and sandbox runtime on this
machine, keeps its settings in its own file, `workspaces/<id>/workspace.json` in the state
directory. The node keeps its own in `buckle.env`. This page lists both, says when a change
applies, and covers the first start of a node set up before workspaces.

## Settings

`buckle workspace show` prints a workspace's `workspace.json`: its policy, where the agent sees
its folder, its variables, its packs, its browser settings, its approval wait, and a revision
counted on at each write. `buckle workspace set <key> <value>` and `unset <key>` change one
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

A variable name that looks like a credential (holding token, secret, password, or key), one
starting `BUCKLE_`, and the names Buckle sets for every command (`PATH`, `HOME`, `USER`,
`LOGNAME`, `SHELL`, and `TMPDIR`) are refused; so is a value that is one of the node's
credentials. Keep secrets in your own secret store: `buckle workspace set` does not echo a
variable's value and no audit record holds it, but `buckle workspace show` prints the file whole,
and every command in the workspace can read it. A call's own `env` is set over the workspace's
variables.

The policy, its command, URL, interpreter, and tool lists, changes with `buckle policy`, which
acts on one workspace as every command does ([Policy](policy.md)). Where the agent sees the
folder changes with `buckle policy mount <path>` and `unmount`.

The browser settings (`browser.cdp`, `browser.profile`, `browser.args`, `browser.headed`, and
`browser.idleTimeoutMs`) are kept in the file but not read yet: the browser runs on the node's
`BUCKLE_BROWSER_CDP`, `BUCKLE_BROWSER_PROFILE`, `BUCKLE_BROWSER_ARGS`, and
`BUCKLE_BROWSER_HEADED` until a later release reads each workspace's own, so `buckle workspace
set` refuses them for now.

## When a change applies

A running `buckle serve` or `buckle mcp` checks a workspace's `workspace.json` at the start of
each call, a cheap look at the file with no watcher. A change to the policy lists, the variables,
or the approval wait applies from that call on; a call already running keeps the rules it started
with. A change to the packs or to where the folder shows waits until the workspace has no active
work, such as a running call or a shell copy awaiting review, and calls are refused with a 409
until then. A file that will not read leaves the settings in force, and the owner's log says so
once. `buckle serve` also takes a change up when it lists the workspaces again.

## Node settings

`buckle.env` holds what every workspace shares: the node's name and id, host and port, the admin
credential, the sandbox mode, logging, request and timeout limits, history and isolation budgets,
the experimental admin face, where programs such as `agent-browser` are, the browser settings
above, `BUCKLE_ALLOWED_HOSTS`, and the [Rings](rings.md) pairing. `buckle settings show` lists
them, and a change to one applies when the node restarts. `buckle settings set` refuses a
setting that belongs to a workspace now, naming the command that changes it, and `buckle
settings unset` removes its line. `BUCKLE_SHELL_NETWORK` and `BUCKLE_SHELL_ISOLATION` stay
node-level settings until Phase 2 of the workspace model moves them into each `workspace.json`.

## Moving a node from 0.1

The first command of this release on a state directory that 0.1 used moves the node onto
workspaces, once, under the registry's lock:

- The folder the node served, `BUCKLE_WORKSPACE_ROOT` or the directory the command runs in,
  becomes workspace `default`, which keeps its records where they were. `BUCKLE_AUTH_TOKEN`
  becomes its token `node`, so agents configured with it keep working.
- Each workspace registered with `buckle workspace add` keeps its id, its folder, and its
  tokens. A disabled or retired one is kept offline. Each workspace's own admin credential goes:
  the node's is the one.
- Every token is kept as its SHA-256 digest alone.
- The settings the environment held (the command, URL, and interpreter lists, the mount, the
  packs and their switches, the approval wait, and the browser settings) are copied into each
  workspace's `workspace.json`. Workspace `default` also keeps the policy `buckle policy` stored.
  A registered workspace keeps exactly what the node enforced on it, its own lists within the
  node's; where no single list can say that, nothing changes, and the start is refused, naming
  the workspace and the lists to settle.
- Grants, remembered denials, and the dangerously-allow switch move from the folder they were
  kept under to the workspace's id.

From then on, the node ignores those settings, the browser's excepted, in `buckle.env`, the
shell, and an MCP client's `env`, and its log names any it finds; `buckle settings unset` removes
them. The browser settings stay live in `buckle.env` until a later release reads each
workspace's own. A state directory that served nothing gets no workspace until `buckle init`
makes one.

The version 1 registry is kept as `workspaces.v1.json`. An older Buckle meeting the new registry
fails closed: it refuses to run programs and to open registered workspaces. To go back to 0.1, stop Buckle, copy `workspaces.v1.json`
over `workspaces.json`, and install the older release; changes made since are not carried back.
