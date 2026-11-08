# Node defaults, and the deny lists every workspace keeps

A node of Buckle, the approval and sandbox runtime on this machine, has settings of its own in
`buckle.env`, in its state directory, and each of its [workspaces](workspaces.md) has its own in
its `workspace.json` ([Workspace settings](workspaces-02.md)).

## How a setting resolves

For each setting a workspace runs under, Buckle takes the workspace's own value, else the node's
value in `buckle.env`, else its built-in default. `buckle workspace unset <key>` takes the workspace's own value out,
so the node's applies again. A workspace's variables (`env.<NAME>`) are its own; where a later release gives the node
variables of its own, the workspace's are set over them, name by name.

The node reads these defaults from `buckle.env` alone, never from a shell's or an MCP config's
`env`: an MCP config an agent could write cannot change them. Nor can a tool: the file tools
refuse `buckle.env`, and the file `BUCKLE_ENV_FILE` names wherever it lies, as Buckle's own state,
and the sandbox hides it from shell commands. With `BUCKLE_SANDBOX=none`, a shell command you
allowed reaches any file your user can, this one included. Nor can it point `buckle mcp` at
another file: `buckle mcp` takes `BUCKLE_ENV_FILE` only where it names a file in the state
directory, and refuses to start otherwise, naming the variable. A command started with one of the
defaults set to another value says at start that it is not read. The move from 0.1 refuses
instead where the command deny or destructive list is set otherwise in its environment, as 0.1
applied that list, and on a node with no `buckle.env` where either is set there at all: put it in
`buckle.env` with `buckle settings set`, or remove it from that environment. On a node with no file,
`buckle init` writes the lists, the agent token, and `BUCKLE_WORKSPACE_ROOT` its environment holds
into the file it makes, says which, and the move runs from there. `buckle settings show` names a default a shell sets as not read. A change
to `buckle.env` applies when the node restarts: `buckle service restart` where a service runs it.

## The policy lists

A workspace's [policy](policy.md) lists resolve in two ways:

- An allow list (the command allow list, the allowed interpreters, the approved hosts and URLs,
  and the tool allow list) is the workspace's own where it has one, else the node's, whole. A
  workspace with a list of its own uses it alone, and the node's list does not narrow it.
- A deny list (the command deny list, the destructive list, and the denied tools) is the node's
  with the workspace's own added. The node's entries apply to every workspace: no workspace
  setting or `buckle policy clear` lifts them. Under the
  [dangerously-allow switch](approvals-04.md) the node's deny entries and denied
  tools still refuse, and its destructive entries are answered at `on` like every other ask, and
  ask a person at `safe`.

An empty list is no list of the workspace's own: `buckle policy remove` of its last entry, or
`buckle policy clear`, gives it the node's list again, and the command says so. A tool allow list
is the one that may be empty, as it then allows no tool.

`buckle policy show` names where each list comes from (the workspace's own, the node's default,
or Buckle's) and marks each deny entry as the node's or the workspace's own. `--json` and the
setup face's policy view carry the same as `sources`.

After the folder's mount, it prints the [mount table](mounts.md) as `buckle workspace mount list`
does: the folder's own entry first, then each mount as `source:target:access`, the node's marked
`(node default)` or `(node scratch root)`. `--json` carries those rows as `mounts`, and so does
`workspace.mounts` in the setup face's status.

## The node's own settings

Some settings belong to the node alone, the same for every workspace, and no workspace sets
them: the host and port, the admin credential, the state directory, the server's id and name, the
sandbox mode, logging, request and timeout caps, history and isolation budgets, the experimental
admin face, where programs such as `agent-browser` are, the toolchains every sandbox binds
(`BUCKLE_MOUNT_READ_ONLY`). Each workspace also takes the node's skill folders and
`BUCKLE_STRICT_WRITES`.

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
| `network-allow` (`BUCKLE_NETWORK_ALLOW`) and `allowed-hosts` (`BUCKLE_ALLOWED_HOSTS`) | the approved hosts and URLs, the two lists as one |
| `network-private-ranges` (`BUCKLE_NETWORK_PRIVATE_RANGES`) | `network.privateRanges` |
| `mounts` (`BUCKLE_MOUNTS`) and `scratch-roots` (`BUCKLE_SCRATCH_ROOTS`) | the [mounts](mounts.md#the-nodes-mounts), read-only entries and folders writable without asking |
| `browser-cdp`, `browser-profile`, `browser-args`, and `browser-headed` (`BUCKLE_BROWSER_*`) | the `browser.*` settings |
| `shell-network` and `shell-isolation` (`BUCKLE_SHELL_*`) | `shell.network` and `shell.isolation` |
| `allowed-interpreters` (`BUCKLE_ALLOWED_INTERPRETERS`) | the allowed interpreters |
| `approval-forms` (`BUCKLE_APPROVAL_FORMS`) | `approval.forms` |
| `approval-session-idle` (`BUCKLE_APPROVAL_SESSION_IDLE_MS`) | `approval.sessionIdleMs` |
| `approval-judge`, `approval-judge-provider`, `approval-judge-model`, and `approval-judge-standard-scripts` (`BUCKLE_APPROVAL_JUDGE*`) | `approval.judge`, `approval.judgeProvider`, `approval.judgeModel`, and `approval.judgeStandardScripts` |
| `approval-quick-judge` and `approval-quick-judge-model` (`BUCKLE_APPROVAL_QUICK_JUDGE*`) | `approval.quickJudge` and `approval.quickJudgeModel`; `approval.quickJudgeProvider` has no node default |
| `delete-in-workspace` (`BUCKLE_DELETE_IN_WORKSPACE`) and `mass-delete-limit` (`BUCKLE_MASS_DELETE_LIMIT`) | `files.deleteInWorkspace` and `files.massDeleteLimit` |

Lists are comma separated; command globs, which hold commas, are separated by `;;`, such as
`buckle settings set command-deny 'curl *;;wget *'`; `mounts` takes the JSON list. The browser
keys are checked as the node reads them together: an attached Chrome (`browser-cdp`) stands
alone, so one beside a profile, arguments, or a window is refused, naming the variables. The
audit log records the key alone for `browser-cdp`, `browser-profile`, and `browser-args` (a DevTools URL,
a profile folder, Chromium arguments), and the value of `browser-headed`. `buckle init --force`, which writes
`buckle.env` again, keeps these defaults from the file it replaces, every one of them.
