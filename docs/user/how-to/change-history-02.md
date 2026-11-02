# The change history, part two

This part covers how the agent reads and restores the change history that Buckle, the approval
and sandbox runtime that runs an AI agent's tool calls, keeps for each workspace, how each restore
asks a person, a workspace in a Git repository, and history without host Git. [Part one](change-history.md) covers what a checkpoint records,
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
conflicts too. The check holds until each path changes: Buckle moves each file aside and checks
it again first, so an edit made meanwhile refuses the restore with nothing changed. A path one of
them recorded without content (ignored, over the cap, or unreadable) is left as it stands, even
where a later one saw it again. Ignore rules never decide what it writes or removes. An agent
restore is itself checkpointed.

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

## A workspace in a Git repository

When a command's folder lies in a Git repository with a commit, Buckle starts the folder's
private index from the repository's own index the first time it records the folder. Git reads
each committed file there once to confirm it holds the committed content, storing nothing. A file
that does not match, such as one whose line ends Git converts or that a filter changes, is stored
the usual way. Later commands read only the files that changed, and a committed file nobody
changed is never copied. Buckle reads the repository with host Git under its isolated settings,
with no hooks, filters, or file monitor. It never writes there, and its sweep never deletes
anything there.

When a command changes or deletes such a file, Buckle copies the content the file had from the
repository into the history before the checkpoint is saved. A restore reads the history alone,
so it works with the repository gone and host Git off. If the repository no longer holds that
content, the path is listed as not restorable, reason `source-gone`, and the call runs as usual.
So a command that deletes `.git`, or prunes its objects, while it changes committed files leaves
those files not restorable.

Content only the repository holds counts nothing toward the rolling cap. The sweep keeps every
copy the folder's index names, even where the repository holds the same content, and none counts
toward the cap: copies an earlier build made, and the copy Git stores of any committed file a
command writes again with the same content, as an install can. Each stays while a file in the
folder holds that content. Buckle never copies a committed file over `history.maxFileBytes` from
the repository, and a change to one is recorded over the cap. A repository with SHA-256 objects,
or a split or sparse index, is recorded the usual way. Buckle refers only to a repository whose
Git folder, objects folder, pack folder, and each loose-object folder are real folders, never
links or junctions, and that has no `alternates` or `http-alternates` file; any other is recorded
the usual way.

Before each command, Buckle checks that the repository still meets that rule, has a commit at
HEAD, and holds the committed content the folder's index refers to. If not, or if the repository
moves, is deleted, or its index turns split or sparse, that command builds the folder's index
again from its files, and stays restorable. A folder an earlier build recorded starts from its
repository at a node's first command there, and keeps the copies it already holds.

## Git history

`git_revert` in the forge pack makes a commit that undoes another commit. It needs `packs.hostGit`
and `BUCKLE_FORGE_GITHUB_TOKEN`, asks as `git_commit` does, and judges each changed file as a
write. It is separate from restoring workspace file changes. See [host Git and
forge](sandbox-and-tools-02.md#host-git-forge-and-language-servers).

## When host Git is off

`packs.hostGit` is off by default. File tools' and the isolated shell's checkpoints restore
without it; a command's checkpoint in the workspace, and a shadow-git one, need it. The
manifest's `history.engine: hashes` and `restorable: false` describe command checkpoints, and
`history.fileToolsRestorable: true` says file tools' checkpoints restore without Git. The
owner enables it with `buckle workspace set packs.hostGit on --workspace <workspace>` and installs
Git on the node PATH outside folders writable by agents. The same setting offers the agent the
`git` and `forge` packs. Check `buckle manifest --workspace <workspace>` after the change. A
command checkpoint made without Git cannot gain content later. If history tools are absent, add
`history` to `packs.enabled` while retaining the existing pack list, and enable `packs.history`.
