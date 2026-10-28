# The change history

Each approved file or shell mutation produces a checkpoint of its changed paths and content.
Buckle stores checkpoints in a shadow Git repository under the node's state directory, one for
each workspace root. Buckle never writes to the workspace's own `.git` directory. [Sandbox and
tools](sandbox-and-tools.md#packs) lists the history pack; [the file floor](policy-04.md) explains
restore approval.

## Capture and retention

When Buckle can use a trusted host Git executable, it builds a tree for each checkpoint and shares
unchanged Git objects. It honors `.gitignore`, excludes the state directory, workspace `.git`, and
protected paths, and can read the workspace repository's object store as a read-only alternate. It
captures raw file bytes without applying Git filters.

The node setting `BUCKLE_HISTORY_MAX_BYTES` limits each shadow store to 268435456 bytes (256 MiB)
by default. Older turns are removed first to keep the store within its rolling cap. If a
checkpoint still cannot fit, Buckle records paths and hashes without content and lets the write
finish. Git garbage collection runs at most once an hour and never on the write path.

The workspace setting `history.maxFileBytes` defaults to 33554432 bytes (32 MiB). A larger file is
recorded by path, size, and hash, without content, and cannot be restored. `history.keepTurns`
defaults to 10. A `5straps/stageId` groups calls in the same session as one turn. Without it,
Buckle starts a new turn after the session is idle for `history.turnIdleMs`, 60000 milliseconds by
default. [Workspace settings](workspaces-02.md#settings) lists these keys.

If Buckle cannot use trusted host Git, it records changed paths and hashes but no file contents;
restores are unavailable. Older SQLite history remains readable by `list` and `recover` until
`buckle history prune --legacy` removes it. Buckle writes new checkpoints only to Git.

## From the terminal

```bash
buckle history list                    # all checkpoints, as a JSON array
buckle history list --last 5           # five newest checkpoints as text, grouped by turn
buckle history restore <id>
buckle history recover <id>
buckle history prune
buckle history prune --legacy         # remove the old SQLite store
```

`--last` accepts 1 to 100 checkpoints, newest first, grouped by turn. `list` reads without the
history lock. `recover`, `restore`, and `prune` wait up to three seconds for a lock. If its
process is still running, the refusal names its pid, start time, and label. `--force` clears a
lock only after that process has exited.

A checkpoint whose finish fails is marked `interrupted` with the reason, and later writes can
continue. A crash may leave a checkpoint `pending`; the agent gets `HISTORY_RECOVERY_NEEDED`, its
id, and `buckle history recover <id>` without waiting. With a person at the `buckle serve`
terminal, `r` recovers it inline.

## The agent's tools

The `history` pack is on by default. Turn it off for a workspace with `buckle workspace set
packs.history off`. When off, both tools are withheld and the manifest says why. `buckle tools`
lists `history_list` and `history_restore`. Tool rules treat them as read and write verbs:
`fs_read` denial hides `history_list`, and `fs_write` denial blocks `history_restore`. Tool allow
lists must name each one.

`history_list({ last })` returns checkpoints and `more`, with 10 by default and 100 at most. Each
checkpoint has a `turnId`; `turns` groups checkpoints, and `changed` lists readable paths from
Git. Paths hidden by read rules count in `unlisted` instead of being named.

`history_restore({ id })`, `history_restore({ steps })`, and `history_restore({ turns })` accept
exactly one target. An id returns the workspace to the state before that checkpoint and later
checkpoints. `steps` counts checkpoints; `turns` counts recent turns. Buckle applies selected
changes through the shadow Git repository. It checks changed paths before applying them and
refuses the whole operation if a path conflicts or policy denies it. An agent restore is itself
checkpointed.

## Every restore asks

`history_restore` asks at the destructive floor every time, whatever the folders' write grants
say, under `write_scope` with subject `restore:<checkpoint>..<newest>`, or `restore:<checkpoint>`
when it is newest. The ask names how many checkpoints it undoes and lists the files it changes. It
offers `once` alone. If the history changes before approval is spent, Buckle asks again rather
than undoing more than the person saw. The owner's `buckle history restore` command needs no
second approver.

Neither [dangerously-allow](approvals.md#dangerously-allow) nor the [decision AI](judge.md)
answers a restore. Every restored path must pass file-policy and mount checks; a deny or conflict
refuses the whole restore. The history belongs to the workspace, so one session can restore
another session's changes. Checkpoints name their session.

## The setup face

`GET /setup/history` and `/workspaces/<id>/setup/history` show the same checkpoint timeline. Their
restore entries identify the checkpoint the workspace returned to and the checkpoints it undid.

## Git history

`git_revert` in the forge pack makes a commit that undoes another commit. It needs `packs.hostGit`
and `BUCKLE_FORGE_GITHUB_TOKEN`, asks as `git_commit` does, and judges each changed file as a
write. It is separate from restoring workspace file changes. See [host Git and
forge](sandbox-and-tools-02.md#host-git-forge-and-language-servers).
