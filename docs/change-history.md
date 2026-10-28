# The change history

Buckle, the approval and sandbox runtime that runs an AI agent's tool calls, keeps its own record
of every change it makes to a workspace's files, apart from Git. Each tool write, delete, move,
and patch, and each shell command's changes, is a checkpoint: the files as they were before the
call and after it. You can list the checkpoints and put files back from the terminal, and the
agent can do the same through two tools, with a person approving every restore.
[Sandbox and tools](sandbox-and-tools.md#packs) lists the packs, and
[the file floor](policy-04.md) the other file calls a person decides.

## Where it is kept

Checkpoints live under `history/` in the workspace's state directory, up to
`BUCKLE_HISTORY_MAX_BYTES` (1 GiB) and `BUCKLE_HISTORY_RETENTION_DAYS` (30). Each one names the
call that made it: its tool, its session, its request id (from this release on), and its stage,
which groups a script's calls. A delete's checkpoint keeps each removed file's content. Hard-linked
dependency files, and names Buckle would read as another path, are left out and listed as not
restorable.

## From the terminal

```bash
buckle history list                    # every checkpoint, as JSON, oldest first
buckle history list --last 5           # the five back from the current one, newest first
buckle history restore <id>            # undo that one checkpoint
buckle history restore-stage <stage> <session>
buckle history recover <id>            # mark an interrupted checkpoint, so changes may go on
buckle history prune                   # drop what is past its retention
```

`--last` takes 1 to 100. Each checkpoint shows its id and time, the tool, session, and request
of the call that made it, and up to ten of its files, relative to the workspace's folder, with the
rest counted. The newest is marked `*` and `current` once it has finished. A restore shows what
it undid. The owner's own restores ask nobody.

## The agent's tools

The `history` pack holds two tools. It is on by default, since every restore asks a person:

```bash
buckle workspace set packs.history off   # this workspace
buckle settings set history off          # every workspace's default, BUCKLE_ALLOW_HISTORY
```

Off, both tools are withheld and the manifest says why. `buckle tools` lists them as
`call history_list` and `call history_restore`, since `buckle history` is the owner's command.
The tool policy reads them as file verbs: `buckle policy deny-tool fs_read` denies
`history_list` too, and `deny-tool fs_write` denies `history_restore`. A tool allow list must name
each to allow it. [Code mode](code-mode.md) reaches both as it reaches every listed tool.

`history_list({ last })` answers the newest `last` checkpoints (10 by default, 100 at most),
newest first, each with the call that made it and its files as the agent names them, the current
one marked. A file the read rules keep from the agent is counted in `unlisted`, not named. It is
a read and asks nobody.

`history_restore({ steps })` or `history_restore({ id })` puts the files back as they were before
one checkpoint: `steps: 1` undoes the newest, `steps: 3` the newest three, and an id goes back to
before that checkpoint, which must be among the newest 100. It undoes that checkpoint and every
later one together, through the same restore path as `buckle history restore`, so a file changed
since is a conflict, refused with nothing changed. The restore is a checkpoint of its own, made
by the agent's call, so `steps: 1` right after it undoes the restore. Steps count checkpoints,
not calls: a script's calls are one checkpoint each.

## Every restore asks

`history_restore` asks at the destructive floor every time, whatever the folders' write grants
say, under the `write_scope` subject `restore:<checkpoint>..<newest>`: the checkpoint it goes back
to before and the newest one then, or `restore:<checkpoint>` when that is the newest. The ask
names how many checkpoints it undoes and lists each file it puts back, a file the checkpoints made as a removal. It offers `once` alone:
no later restore undoes the same checkpoints from the same newest one, so a grant for the session
or always would never be used. If a checkpoint lands before the approval is spent, the call asks
again rather than undo more than the person saw. The restore checks the history again under its
lock and runs only where it still stands as it was judged.

Neither the [dangerously-allow switch](approvals.md#dangerously-allow), at either level, nor the
[decision AI](judge.md) answers it. Each file it puts back is also judged as a write: a file in
a read-only mount, beyond the mount, in Buckle's state, or under a filesystem `deny` rule refuses
the whole restore, and a filesystem `ask` rule asks too.

## What is refused

- Steps past the start of the history, or an id that is not among the newest 100, before anything
  asks (`RESTORE_REFUSED`). A checkpoint past its retention is not offered, though the next change
  prunes it; a restore never prunes the ones it restores from.
- A checkpoint an interrupted call left, until the owner recovers it. While another call is
  changing files, the refusal says to try again.
- A file it would put back that changed outside Buckle since the newest checkpoint, or between two
  of the checkpoints it undoes.
- A restore that would put back anything inside a `.git` directory, since that rewinds the
  repository's commits, branches, and index and can delete a commit a branch still points to.
  Undo a commit with `git_revert`. The owner's `buckle history restore` is not refused.

## Limits

- The history is the workspace's, not a session's: steps count every session's checkpoints, so a
  restore can undo another session's change. Each checkpoint names its session, and the ask
  lists every file.
- `current` marks the newest checkpoint without reading the files, so a change made outside
  Buckle since shows only when a restore meets it as a conflict.

## The setup face

`GET /setup/history`, and its `/workspaces/<id>/setup/history` twin, serve every checkpoint as
`buckle history list` lists it, now with `requestId` and, for an agent's restore, `undoes`: what a
history view draws its timeline from. A restore names the checkpoint it went back to before
(`restores`), where a tree view branches.

## Git history

`git_revert` in the forge pack makes a new commit that undoes one commit, under the node's agent
identity; it never resets ([host Git and forge](sandbox-and-tools-02.md#host-git-forge-and-language-servers)).
Like the rest of that pack it needs `packs.hostGit` on and `BUCKLE_FORGE_GITHUB_TOKEN`, and it
asks as `git_commit` asks, then judges each file it rewrites as a write. Its checkpoint holds the
repository's own files, so `history_restore` over it is refused as above.
