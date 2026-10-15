# Installing Buckle: the state directory

Buckle, the approval and sandbox runtime on this machine, keeps its records in one state
directory. This page says where it is, how it is protected, and what each file holds.
[Installing Buckle](install.md) covers installing, checking, upgrading, and removing it.

## What the state directory holds

The state directory is `~/.5straps/buckle`, or the absolute path in `BUCKLE_STATE_DIR`; a
relative path is refused. On Linux and macOS, Buckle creates it owner-only (mode 700), writes
its state files owner-only (mode 600), and refuses to start when other users can reach the
directory, unless you pass `--skip-owner-only-check`. On Windows, Buckle leaves file permissions
alone: Windows protects the default one under your profile, and one moved elsewhere is yours to
protect. It refuses a workspace folder that holds the state directory, where an agent writes
anywhere. Buckle's file tools refuse to read or write
anything under `~/.5straps` or the state directory. Only a process sandbox hides both from shell
commands: with `BUCKLE_SANDBOX=none`, a shell command can read and write them, and Buckle does
not ask about them.

Each workspace keeps the files from `dangerously-allow.json` down in its own `workspaces/<id>/`,
the workspace Buckle makes of a 0.1 node's own folder included.

| Path | Holds |
|---|---|
| `buckle.env` | the node's settings, every workspace's defaults among them, and its admin credential |
| `workspaces.json` | each workspace's id, name, folder, whether it is online, and its agent tokens' SHA-256 digests |
| `workspaces/<id>/` | the workspace's `workspace.json`, its settings and policy, and its records |
| `workspaces.v1.json`, `policy.json` | on a node moved from 0.1 only: the 0.1 registry, and a stub an older Buckle cannot read, where `policy.v1.json` keeps the 0.1 policy |
| `grants.v1.json`, `dangerously-allow.v1.json` | on a moved node only: the 0.1 grants and switch, kept where 0.1 read each, in the state directory and in the old `workspaces/<0.1 id>/` of each workspace registered then |
| `client-keys.json`, `client-keys.v1.json` | the device keys enrolled with `buckle keys enroll`, each with the workspace it signs for; on a node moved from 0.1 where a key named a workspace, the copy keeps the keys as 0.1 named them |
| `workspaces/<0.1 id>/policy.json` | a workspace registered under 0.1 keeps its old policy there, read once at the move and unread since |
| `dangerously-allow.json` | the dangerously-allow switch, where it is on |
| `grants.json` | session and always grants, and remembered denials |
| `approvals.json`, `approval-calls/` | asks waiting for a person, recent decisions, unspent once approvals, and the whole call behind each ask |
| `actions.jsonl` | the [audit log](audit-log.md) |
| `plugins.json` | plugins added with `buckle plugin add` |
| `history/` | checkpoints of file changes, read by `buckle history` |
| `code-journal/` | stopped scripts' text and calls' results, kept ten minutes |
| `isolated-shell/` | the private workspace copies shell commands run in |
| `browser-sessions/`, `workbenches/`, `receive-git-hooks/` | browser session state, workbench files, and the guard hook local pushes run |
| `*.lock.sqlite` | locks that let several Buckle processes share these files |

Next: [First run](first-run.md).
