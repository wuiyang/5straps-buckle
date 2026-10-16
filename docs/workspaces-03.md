# Node defaults, and the deny lists every workspace keeps

A node of Buckle, the approval and sandbox runtime on this machine, has settings of its own in
`buckle.env`, in its state directory, and each of its [workspaces](workspaces.md) has its own in
its `workspace.json` ([Workspace settings](workspaces-02.md)). This page says how the two make
the settings a workspace runs under.

## How a setting resolves

For each setting a workspace runs under, Buckle takes the workspace's own value, else the node's
value in `buckle.env`, else its built-in default. A workspace that sets nothing of its own runs
on the node's settings; one that sets `packs.shell off` keeps the shell off whatever the node
says. `buckle workspace unset <key>` takes the workspace's own value out, so the node's applies
again. A workspace's variables (`env.<NAME>`) are its own; where a later release gives the node
variables of its own, the workspace's are set over them, name by name.

The node reads these defaults from `buckle.env` alone, never from a shell's or an MCP config's
`env`: an MCP config an agent could write cannot change them. Nor can it point `buckle mcp` at
another file: `buckle mcp` takes `BUCKLE_ENV_FILE` only where it names a file in the state
directory, and refuses to start otherwise, naming the variable. A command started with one of the
defaults set to another value says at start that it is not read. The move from 0.1 refuses
instead where the command deny or destructive list is set otherwise in its environment, as 0.1
applied that list: put it in `buckle.env` with `buckle settings set`, or remove it from that environment. A change to `buckle.env` applies when
the node restarts.

## The policy lists

A workspace's [policy](policy.md) lists resolve in two ways:

- An allow list (the command allow list, the allowed interpreters, the approved hosts and URLs,
  and the tool allow list) is the workspace's own where it has one, else the node's, whole. A
  workspace with a list of its own uses it alone, and the node's list does not narrow it.
- A deny list (the command deny list, the destructive list, and the denied tools) is the node's
  with the workspace's own added. The node's entries apply to every workspace: no workspace
  setting or `buckle policy clear` lifts them. Under the
  [dangerously-allow switch](approvals.md#dangerously-allow) the node's deny entries and denied
  tools still refuse, and its destructive entries are answered like every other ask.

An empty list is no list of the workspace's own: `buckle policy remove` of its last entry, or
`buckle policy clear`, gives it the node's list again, and the command says so. A tool allow list
is the one that may be empty, as it then allows no tool.

`buckle policy show` names where each list comes from (the workspace's own, the node's default,
or Buckle's) and marks each deny entry as the node's or the workspace's own. `--json` and the
setup face's policy view carry the same as `sources`.

## The node's own settings

Some settings belong to the node alone, the same for every workspace, and no workspace sets
them: the host and port, the admin credential, the state directory, the server's id and name, the
sandbox mode, logging, request and timeout caps, history and isolation budgets, the experimental
admin face, where programs such as `agent-browser` are, the browser settings for now, the pairing
with [Rings](rings.md), the 5straps control plane for agents, and `BUCKLE_ALLOWED_HOSTS`. Each workspace also takes the node's
scratch roots, `BUCKLE_MOUNTS`, skill folders, and `BUCKLE_STRICT_WRITES` until Phase 2 of the
workspace model gives each workspace a mount table of its own. `BUCKLE_SHELL_NETWORK` and
`BUCKLE_SHELL_ISOLATION` stay the node's until then too.

`buckle settings show` lists the node's settings, then the workspace defaults, each with its
value and where it comes from. `buckle settings set <key> <value>` and `unset <key>` change one,
checked as a workspace's own would be:

| Key | Default of |
|---|---|
| `approval-wait` (`BUCKLE_APPROVAL_TIMEOUT_MS`) | `approvalWaitMs` |
| `mount` (`BUCKLE_WORKSPACE_MOUNT`) | `mount` |
| `packs` (`BUCKLE_PACKS`) | `packs.enabled` |
| `shell`, `code`, `host-git`, and `host-lsp` (`BUCKLE_ALLOW_*`) | the `packs` switches |
| `command-allow` (`BUCKLE_COMMAND_ALLOW`) | the command allow list |
| `command-deny` (`BUCKLE_COMMAND_DENY`) | the command deny list, for every workspace |
| `command-destructive` (`BUCKLE_COMMAND_DESTRUCTIVE`) | the destructive list, for every workspace |
| `network-allow` (`BUCKLE_NETWORK_ALLOW`) | the approved hosts and URLs |
| `allowed-interpreters` (`BUCKLE_ALLOWED_INTERPRETERS`) | the allowed interpreters |

Lists are comma separated; command globs, which hold commas, are separated by `;;`, such as
`buckle settings set command-deny 'curl *;;wget *'`. `buckle init --force`, which writes
`buckle.env` again, keeps these defaults from the file it replaces.
