---
name: buckle-history
description: Read the change history of a 5straps Buckle workspace and roll the workspace's files back to before a checkpoint. Use when a change you or another call made should be undone, or to see what changed lately and which call changed it.
---

# Buckle change history

Every file write, delete, move, patch, and shell change Buckle makes is a checkpoint: what the
paths it changed were before and after it. History never refuses a call: where it could not record
a change, the call still runs, and the checkpoint says `restorable: false` with a `reason`. Two
tools read and use that history.

## history_list

`history_list({ last })` answers the newest `last` checkpoints (10 by default, at most 100), from
the current state back, newest first. Each has its `id`, `createdAt`, the call that made it
(`tool`, `sessionId`, `requestId`, `stageId`), its `turnId`, its `status`, and `changes`: each
file it changed, with `kind` `created`, `modified`, or `deleted`. The newest is marked
`current: true` once it has finished. `restorable` and `reason` say whether it can be restored,
and `notRestorable` names files it changed without keeping their content (over the size cap, for
one). `ignored` counts a command's changes under paths the workspace's `.gitignore` covers, which
history never stores or restores. `unlisted`, `changedUnlisted`, and `notRestorableUnlisted` count
files left out: past the first 100, or ones the read rules keep from you. `turns` groups the
checkpoints by user turn, and `more: true` says older checkpoints are kept. A restore shows
`restores`, the checkpoint it went back to before, and `undoes`, how many it undid.

It is a read: it asks nobody.

## history_restore

`history_restore` puts the workspace's files back as they were before one checkpoint, undoing it
and every later one together:

- `{ "steps": 1 }` undoes the newest checkpoint; `{ "steps": 3 }` the newest three.
- `{ "id": "change-..." }` goes back to before that checkpoint, one of the newest 100.
- `{ "turns": 1 }` undoes every checkpoint of the newest user turn; `{ "turns": 2 }` the newest two.

Name one of the three. Every restore asks a person, whatever the folders' write grants say, and
offers a single approval: the ask names the checkpoint it goes back to and the newest one, so an
approval never covers a restore that undoes more. If a call lands a new checkpoint before the
approval is spent, the call asks again.

The answer names the restore's own checkpoint (`checkpoint`), what it went back to before
(`restores`), how many it undid (`undoes`), and `changes`. The restore is itself a checkpoint,
so `{ "steps": 1 }` right after it undoes the restore. The ask lists a file the checkpoints
made as one the restore removes.

## What is refused

- Steps past the start of the history, or an id not among the newest 100: refused before
  anything asks (`RESTORE_REFUSED`). A checkpoint past its retention is not offered.
- A file the restore would put back changed outside Buckle since the newest checkpoint, or
  between two of those it undoes: refused, nothing changed, the file named. Read the file and
  decide yourself.
- A checkpoint with `restorable: false`: refused with its `reason`, such as a call Buckle stopped
  in, or a command run without host Git. While another call is changing files, the refusal says to
  try again shortly instead.
- A restore that would put back anything inside a `.git` directory: refused, since it rewinds the
  repository. Undo a commit with `git_revert`.
- A path it would put back in a read-only mount, in Buckle's state, or where the workspace
  policy denies writing: refused as that write would be.

Git history is another thing: `git_revert` in the forge pack makes a new commit that undoes one.
