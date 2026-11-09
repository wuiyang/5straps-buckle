# Installing Buckle: the state directory

Buckle keeps its records in one state directory. [Installing Buckle](install.md) covers
installing, checking, upgrading, and removing it.

## What the state directory holds

The state directory is `~/.5straps/buckle`, or the absolute path in `BUCKLE_STATE_DIR`; a
relative path is refused. On Linux and macOS, Buckle creates it owner-only (mode 700), writes
its state files owner-only (mode 600), and refuses to start when other users can reach the
directory, unless you pass `--skip-owner-only-check`. On Windows, Buckle leaves file permissions
alone: Windows protects the default one under your profile, and one moved elsewhere is yours to
protect. It refuses a workspace folder that holds the state directory, where an agent writes
anywhere. Buckle's file tools refuse to read or write anything under `~/.5straps` or the state
directory, or the file `BUCKLE_ENV_FILE` names wherever it lies, and the change history keeps no
copy of them. Only a process sandbox hides them from shell commands: with `BUCKLE_SANDBOX=none`, a
shell command can read and write them, and Buckle does not ask about them.

Each workspace keeps the files from `dangerously-allow.json` down in its own `workspaces/<id>/`,
the workspace Buckle makes of a 0.1 node's own folder included.

| Path | Holds |
|---|---|
| `buckle.env` | the node's settings, every workspace's defaults among them, and its admin credential |
| `environment-files.json` | each settings file outside the state directory that `buckle init --out`, `buckle service install`, or a serve named, so every Buckle process keeps it from tools, one already running from its next call; Buckle never drops one ([known limits](../caveats/known-limits-11.md)); while it will not read, each command refuses to start, naming it, and a running process refuses each call |
| `workspaces.json` | each workspace's id, name, folder, whether it is online, and its agent tokens' SHA-256 digests |
| `workspaces/<id>/` | the workspace's `workspace.json`, its settings and policy, and its records |
| `workspaces/<id>/removed.json` | what `buckle workspace remove` leaves beside a removed workspace's kept records: its folder, name, and removal time, read by `buckle workspace prune` and cleared when the folder is added again |
| `workspaces/<id>/sandbox-etc/` | where bubblewrap runs shell commands: the `passwd` and `group` files the sandbox shows as its `/etc/passwd` and `/etc/group` (the user and group `agent`), and the `hosts` file naming the host `buckle` |
| `workspaces/<id>/active-work/` | one empty file for each process with calls running, so `disable`, `remove`, and `prune` in another process can see them, and an `executing-<id>` file for each process while one of its tools runs or one of its calls waits for your answer, naming those sessions, the asks held, and the process's pid |
| `workspaces.v1.json`, `policy.json` | on a node moved from 0.1 only: the 0.1 registry, and a stub an older Buckle cannot read, where `policy.v1.json` keeps the 0.1 policy |
| `grants.v1.json`, `dangerously-allow.v1.json` | on a moved node only: the 0.1 grants and switch, kept where 0.1 read each, in the state directory and in the old `workspaces/<0.1 id>/` of each workspace registered then |
| `client-keys.json`, `client-keys.v1.json` | the device keys enrolled with `buckle keys enroll`, each with the workspace it signs for; on a node moved from 0.1 where a key named a workspace, the copy keeps the keys as 0.1 named them |
| `workspaces/<0.1 id>/policy.json` | a workspace registered under 0.1 keeps its old policy there, read once at the move and unread since |
| `dangerously-allow.json` | the dangerously-allow switch's mode, where it is `on` or `safe`; a version 1 file an earlier build wrote reads as off, and the first time the switch is set it is kept whole as `dangerously-allow.earlier.json` |
| `grants.json` | session and always grants, and remembered denials |
| `approvals.json`, `approval-calls/`, `approval-revocations.json` | asks waiting for a person, recent decisions, unspent once approvals, the whole call behind each ask, and revokes and session ends not yet finished (made while `approvals.json` could not be read, or whose grants could not yet be removed from `grants.json`), kept until the next decision, ask, or spent once finishes them; the approvals they name clear no call meanwhile. While that last file is damaged, those are refused and no session approval clears a call, and removing it forgets what it held, so check `buckle grants` and `buckle approvals`, and revoke or deny again |
| `actions.jsonl` | the [audit log](../how-to/audit-log.md): in the state directory the node's own commands and refusals, and in each workspace's folder its calls |
| `plugins.json` | plugins added with `buckle plugin add` |
| `history/` | checkpoints of file changes, read by `buckle history`, and `activity.sqlite`, each session's last activity, which the [idle end of sessions](../how-to/approvals-07.md) reads |
| `code-journal/` | stopped scripts' text and calls' results, kept ten minutes |
| `isolated-shell/` | the private workspace copies shell commands run in |
| `browser-sessions/`, `workbenches/`, `receive-git-hooks/` | browser session state, workbench files, and the guard hook local pushes run |
| `service/` | for a node running with no terminal ([service](../how-to/service.md)): `serve.json` (its pid, version, and address), the lock it holds while it serves, a stop request `buckle service stop` writes, and on Windows `task.xml`, the task as installed |
| `logs/` | `buckle.log`, the log of a node running with no terminal, and its five earlier files; on macOS also `launchd.log`, what launchd caught before the node opened its own |
| `*.lock.sqlite` | locks that let several Buckle processes share these files |

Next: [First run](first-run.md).
