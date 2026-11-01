# The change history, part two

This part covers how the agent reads and restores the change history that Buckle, the approval
and sandbox runtime that runs an AI agent's tool calls, keeps for each workspace, how each restore
asks a person, and history without host Git. [Part one](change-history.md) covers what a checkpoint records,
retention, older checkpoints, and the owner's commands; [the file floor](policy-04.md) explains
restore approval.

## The agent's tools

The `history` pack is on by default. Turn it off for a workspace with `buckle workspace set
packs.history off`. When off, both tools are withheld and the manifest says why. `buckle tools`
lists `history_list` and `history_restore`. Tool rules treat them as read and write verbs:
`fs_read` denial hides `history_list`, and `fs_write` denial blocks `history_restore`. Tool allow
lists must name each one.

`history_list({ last })` returns checkpoints and `more`, with 10 by default and 100 at most. Each
checkpoint has a `turnId`; `turns` groups checkpoints. `changed` and `notRestorable` each list up
to 100 readable paths; `changedUnlisted` and `notRestorableUnlisted` count omitted or read-denied
paths instead of naming them. `ignored` counts a command's changes under ignored paths.

`history_restore({ id })`, `history_restore({ steps })`, and `history_restore({ turns })` accept
exactly one target. An id returns the workspace to the state before that checkpoint and later
checkpoints. `steps` counts checkpoints; `turns` counts recent turns. Buckle puts back only the
paths those checkpoints changed. Each must stand as the newest of them left it, or the restore is
refused naming that path; a folder it would remove that holds an entry no checkpoint names
conflicts too. Ignore rules never decide what it writes or removes. An agent restore is itself
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

## When host Git is off

`packs.hostGit` is off by default. File tools' and the isolated shell's checkpoints restore
without it; a command's checkpoint in the workspace, and a shadow-git one, need it. The
manifest's `history.engine: hashes` and `restorable: false` describe command checkpoints. The
owner enables it with `buckle workspace set packs.hostGit on --workspace <workspace>` and installs
Git on the node PATH outside folders writable by agents. The same setting offers the agent the
`git` and `forge` packs. Check `buckle manifest --workspace <workspace>` after the change. A
command checkpoint made without Git cannot gain content later. If history tools are absent, add
`history` to `packs.enabled` while retaining the existing pack list, and enable `packs.history`.
