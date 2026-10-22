# Workspace settings

Each [workspace](workspaces.md) of a node of Buckle, the approval and sandbox runtime on this
machine, keeps its own settings in `workspaces/<id>/workspace.json` in the state directory. The
node keeps its own in `buckle.env`, and those are every workspace's defaults: a setting a
workspace leaves unset is the node's, else Buckle's built-in one. This page lists the settings
and says when a change applies; [moving from 0.1](workspaces-04.md) has its own page. [Node
defaults](workspaces-03.md) covers how each setting resolves, the deny lists every workspace is
held to, and the node's own settings.

## Settings

`buckle workspace show` lists each setting in force and where it comes from: `workspace`, its
own `workspace.json`; `node default`, the node's `buckle.env`; or `built-in`. `--json` adds the
file as stored. `buckle workspace set <key> <value>` gives the workspace a value of its own,
checked whole with the rest before anything is written; `unset <key>` takes it out, so the
node's applies again:

| Key | Takes | Built-in |
|---|---|---|
| `name` | the workspace's name: what the node shows, and `--workspace` takes | the folder's name |
| `env.<NAME>` | a variable its shell commands see | none |
| `mount` | where the agent sees the folder, such as `/workspace` | its real path |
| `approvalWaitMs` | milliseconds a gated call waits for an answer; `0` waits until someone answers | `15000` |
| `packs.enabled` | the packs offered, comma separated, which leaves plugins out | every built-in pack, and plugins |
| `packs.shell` | `on` or `off`: the shell pack | on |
| `packs.code` | `on` or `off`: [code mode](code-mode.md) | on |
| `packs.hostGit` | `on` or `off`: the `git` and `forge` packs, which read the repository outside per-file checks | off |
| `packs.hostLsp` | `on` or `off`: language servers in the `dev` pack | off |
| `shell.network` | `on` or `off`: shell commands may reach the network while no approved list is set | off |
| `shell.isolation` | `on` or `off`: each shell command runs on a private copy of the folder | on |
| `browser.idleTimeoutMs` | milliseconds an idle browser lives, `60000` to `86400000` | `300000` |
| `browser.profile`, `browser.cdp`, `browser.args`, `browser.headed` | the browser's profile folder, attached Chrome, arguments, and window ([Using your own browser](browser-login.md)) | a fresh, headless browser |
| `approval.judge` | the [decision AI](judge.md), an optional model check: `off`, `on-request`, or `automated` | `off` |
| `approval.judgeProvider` | the thorough model's provider: `openai-compatible` | `openai-compatible` |
| `approval.judgeModel` | the thorough model's name, as your AI gateway serves it | `gpt-6-luna` |
| `approval.judgeStandardScripts` | commands rated on their command line alone, globs separated by `;;` | [the standard scripts](judge.md#standard-development-scripts) |
| `approval.quickJudge` | what Jev, TypeSafe AI's quick decision model, rates: `off`, `interpreters`, `asks`, or `all` | `off` |
| `approval.quickJudgeProvider` | Jev's provider: `typesafe` | `typesafe` |
| `approval.quickJudgeModel` | Jev's model name | `jev-latest` |

The browser's mode is one setting: a workspace that sets its own `browser.cdp` or
`browser.profile` takes both from itself, never the node's other one, and under an attached Chrome
the node's `browser.args` and `browser.headed` do not apply. A workspace's own arguments or window
beside the node's `BUCKLE_BROWSER_CDP` is refused, naming it, at `buckle workspace set` and in a
hand-edited `workspace.json`.

A new workspace sets its mount, `/workspace`, and nothing else. Its [mounts](mounts.md) change
with `buckle workspace mount`. `buckle workspace set` refuses a
node setting, naming the command or file that changes it.

A variable name that looks like a credential (holding token, secret, password, or key) is taken,
with a warning that its value is plain text in `workspace.json` and reaches every command. A name
starting `BUCKLE_`, and the names Buckle passes to every command (`PATH`, `HOME`, `USER`,
`LOGNAME`, `SHELL`, and `TMPDIR`), are refused. So is a value that contains a secret the node
holds (the admin token, `BUCKLE_AUTH_TOKEN`, the forge token, the Brave search key, the report
token, the Rings pairing key, or the approval webhook's URL) or a workspace's agent token as a
word of it. Keep real secrets in your own store: `buckle workspace show` prints the variables,
and every command can read them. A call's own `env` is set over them.

The policy lists change with `buckle policy` ([Policy](policy.md)). A profile folder or an
attached Chrome belongs to one workspace at a time: naming one another workspace names as its own
is refused, naming that workspace.

## When a change applies

A running `buckle serve` or `buckle mcp` watches a workspace's state folder and takes a change up
while the workspace is idle, with a check at each call's start as the fallback. A change to the
policy lists, the variables, the browser settings, or the approval wait applies from the next
call, even while another runs, which keeps its own rules; a list change alone waits while a
workbench that process runs is open, as taking it up stops its terminals. A change to the packs,
to where the folder shows, to the mounts, or to the shell settings waits until the workspace has
no active work, such as a running call or a shell copy awaiting review. A waiting change, or one that will not apply, refuses calls with a 409 until it applies.
A file that will not read leaves the settings in force, and the owner's log says so.
`buckle serve` watches the registry folder too, its poll the fallback. A change to `buckle.env`
applies when the node restarts: `buckle service restart` where a service runs it.
