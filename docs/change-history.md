# The change history

Buckle, the approval and sandbox runtime that runs an AI agent's tool calls, keeps a change
history for each workspace: a checkpoint for every call that changes files, holding what each
path it changed was before and after it. The agent or the owner can put those paths back.
[Sandbox and tools](sandbox-and-tools.md#packs) lists the history pack. [Part
two](change-history-02.md) covers the agent's tools, the restore ask, and history without host
Git. Buckle never writes to the workspace's own `.git`.

## What a checkpoint records

- **File tools.** `fs_write`, `fs_write_batch`, `fs_patch`, `fs_apply_patch`, `fs_delete`,
  `fs_move`, and `fs_receive` name every path they change. Before the call, Buckle stores each
  path's state: absent, a file's content and mode, a link's target, or, for a folder deleted or
  moved, everything in it. After the call, it stores the new state. Nothing else is read, no
  ignore rule applies, and no program starts, so a file `.gitignore` covers is still recorded
  when the agent changes it.
- **The isolated shell.** A command run on a private copy publishes its changes as one
  checkpoint of the paths it changed, read the same way.
- **Commands in the workspace.** With `shell.isolation` off, a command can change anything, such
  as a build or an install. Buckle asks Git what changed, through a private index under the
  node's state: before and after the command it adds the workspace's folders and writes a tree,
  and the difference names the changed paths. The workspace's own ignore rules, every
  `.gitignore` and the repository's `info/exclude`, decide what Git reads. Changes under ignored
  paths are counted, never stored, and never touched by a restore. A protected path is never
  read, whatever a `.gitignore` re-includes. A folder Git does not track, such as an empty one,
  a file Git could not read, and what stands in a folder it could not open keep their place: a
  restore never removes or rewrites them. Buckle learns of them from Git's own listings, never by
  walking a folder. A folder a command makes inside one that holds nothing Git stores stays after
  a restore, listed as not restorable, as it may have stood there before. A workspace with no
  `.gitignore` tracks everything, within the caps. A nested repository is left out, reason
  `nested`. Each phase has 30 seconds; past that, or once the call is cancelled
  before the command starts, the command runs without restorable content. This needs permitted,
  trusted host Git; without it, the command runs and its checkpoint reads "Not restorable: host
  git needed".

Content is kept as Git-format loose objects in the workspace's `history/` state folder. Buckle
writes and reads them itself, so a restore starts no Git program.

## Retention

`history.keepTurns` keeps the last 10 turns by default. A real `5straps/stageId` groups calls only
within the same session. Without one, a new turn starts after more than `history.turnIdleMs`
milliseconds without a call in that session (60000 by default). Calls, including reads, refresh
idle activity, which survives restart; approval and lock waits keep a call in its starting turn.
[Workspace settings](workspaces-02.md#settings) lists these keys.

`history.maxFileBytes` defaults to 33554432 bytes (32 MiB). A larger file is recorded by path and
size, reason `size`, and cannot be restored. The node setting `BUCKLE_HISTORY_MAX_BYTES` caps the
content kept checkpoints hold at 268435456 bytes (256 MiB) by default, each object counted once;
the copy a command's private index keeps does not count. Over the cap, Buckle drops whole oldest
turns, never the current one, and deletes the objects nothing names; so does a sweep after each
command, which removes a file over the cap and what a stopped write left. A checkpoint that alone
exceeds the cap keeps its paths without content. Retention never rewrites a kept checkpoint and
never reads the workspace. `BUCKLE_HISTORY_RETENTION_DAYS` controls isolated-shell recovery
copies, not these turns.

## Never in the way

History never refuses a call. When a capture fails, the call runs, and its checkpoint is marked
not restorable with the reason. The agent sees the reason in the call's history notice: MCP
returns structured history metadata, while the CLI and `buckle cp` print it to stderr. The
owner's log names the cause. A checkpoint left pending when Buckle stopped is marked
`interrupted`, with its reason, by the next call. A journal that cannot be read is moved aside
to `checkpoints.json.damaged-<date>` beside it, kept for the owner, and history starts a fresh
one; the next call's notice says so, and the log names the cause.

## Older checkpoints

Checkpoints from the shadow-git store of earlier builds, and from the SQLite history before it,
stay listed. A shadow-git one restores through that store with permitted, trusted host Git;
without Git, the restore is refused before anything asks, and the listing says why. Buckle
copies into that store the objects it borrowed from the workspace's repository, so pruning the
repository keeps them. A SQLite one is listed only. Once as many turns of new checkpoints follow
as `history.keepTurns` keeps, their checkpoints leave the journal, and Buckle moves both stores
aside and deletes them in the background. `buckle history prune --legacy` removes the SQLite
store at once.

## From the terminal

```bash
buckle history list                    # all checkpoints, as a JSON array
buckle history list --last 5           # five newest checkpoints as text, grouped by turn
buckle history restore <id>
buckle history recover <id>
buckle history prune
buckle history prune --legacy         # remove the old SQLite store
```

`--last` accepts 1 to 100 checkpoints, newest first, under turn headings. It prints up to ten
changed and ten non-restorable paths per checkpoint, counts the remainder, and shows any
non-restorable reason. `recover <id>` prints an interrupted checkpoint and its reason; nothing
needs recovering. `list` reads without the history lock. `recover`, `restore`, and `prune` wait
up to three seconds for it. If its process is still running, the refusal names its pid, start
time, and label. `--force` refuses at once while that process runs, and removes nothing.
