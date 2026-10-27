# Policy: the file floor

The file floor is the set of file calls that a person decides, whatever a folder's write grant
says. It works like the [command floor](approvals.md#the-destructive-floor). It covers the file
tools `fs_delete`, `fs_move`, and `fs_apply_patch`, and the writes that the other write tools
make ([the fs pack](sandbox-and-tools.md#packs)). [Policy](policy.md) lists the rules a
call meets, and [known limits, part eight](known-limits-08.md) lists what the floor does not cover.

## What asks

- `fs_delete` asks on every call. A batch asks once for each folder it names, and a folder removed
  whole asks on its own. The reason reads "Deleting ... always asks a person, whatever the
  folder's write grant says".
- `fs_move` asks at the floor when `replace` is true, or when `from` is a folder. The replaced
  file gets its own ask, and its reason names that file. Otherwise the move asks as a write to
  `to`'s folder does: the first write into a directory asks, and a grant is remembered. Its removal
  of `from` is judged as a write to `from`'s folder.
- A write that empties an existing file, or leaves it under half its size, asks when the session
  has not seen that file lately. The writing tools are `fs_write`, `fs_write_batch`, `fs_patch`,
  `fs_apply_patch`, and `fs_receive` over an existing file. The reason reads "Writing ... empties
  a file this session never read", or "shrinks a file this session never read to under half its
  size".
- A call that rewrites more than 10 existing files at once asks: "This call rewrites N existing
  files at once".
- In a shell, a plain `rm` with a glob character (`*`, `?`, or `[`) in a target, quoted or not,
  or with two or more targets, asks as "Delete of several files". `rm file` with one literal path
  does not ask here. `rm -r` and `rm -f` still ask at the command floor.

## What the session has seen

The session has seen a file when `fs_read`, `fs_read_batch`, or a `fs_search_content` match
reached it, or when the session wrote it itself. A partial read, with `offset` or `limit`, counts.
A sighting holds for one hour. Each session keeps at most 10,000 paths, and Buckle keeps at most
1,000 sessions, forgetting the least recently used first. The record is in memory only, so a
restart forgets it, and the first such write after a restart asks. Another session's reads do not
count for this one. The thresholds, half the size, 10 files, and one hour, are fixed in this release.

## Scopes and grants

- The file floor offers `once`, `session`, and `always`. With `BUCKLE_STRICT_WRITES=true` it
  offers `once` alone. The command floor offers `once` and `session` only.
- A grant on `delete:<folder>` covers the entries directly in that folder, matched exactly. It
  never covers a folder beneath it.
- A folder removed whole asks under `delete-tree:<path>`, and its grant covers that one removal.
- The other subjects are `overwrite:<file>`, for the destructive-write check on one file, and
  `rewrite-batch:<folder>`, for a batch. A folder's write grant never matches any of these.
- `buckle grants list` shows the grants, and `buckle grants revoke <id>` removes one.

## Refused, not asked

- Deleting or moving the workspace folder, a mount's source, a folder that holds one of them, a
  read-only mount's source, or a folder that holds Buckle's state. A folder holding Buckle's state
  is refused with "The folder holds Buckle's own state and policy, which no tool removes or moves".
- A folder with entries, without `recursive: true`, is refused as `FOLDER_NOT_EMPTY`, before any
  ask. So are a socket, a device, and a pipe.
- A `deny` on `fs_write` also denies `fs_delete`, `fs_move`, and `fs_apply_patch`, as the tool
  policy maps it for the path. An `allow-tool` lifts it, as for any tool.
- A filesystem `deny` rule beneath a folder removed whole denies that delete. An `ask` rule
  beneath it asks once.

## Dangerously allow

Inside the workspace folder, the [dangerously-allow switch](approvals.md#dangerously-allow)
answers the file floor as it answers `rm -r`. Outside that folder, and in a scratch root, a
person still decides.

The [decision AI](judge.md) never rates these asks. A person decides each one.
