# Policy: the file floor

The file floor is the set of file calls that a person decides, whatever a folder's write grant
says. It works like the [command floor](approvals.md#the-destructive-floor). It covers the file
tools `fs_delete`, `fs_move`, and `fs_apply_patch`, and the writes that the other write tools
make ([the fs pack](sandbox-and-tools.md#packs)). Inside the workspace's own folder, a delete
follows the workspace's [delete policy](policy-05.md), which by default lets it run where writes
are granted. [Policy](policy.md) lists the rules a call meets, and [known limits, part
eight](known-limits-08.md) lists what the floor does not cover.

## What asks

- `fs_delete` asks outside the workspace's folder, and inside it under `files.deleteInWorkspace
  ask` or past the [mass-delete guard](policy-05.md#the-mass-delete-guard), unless a person
  granted deletes in that folder (see the scopes below). A path
  missing inside the workspace asks nothing. A batch asks once for each folder it names, and a
  folder removed whole asks on its own. The reason reads "Deleting ... asks a person, whatever
  the folder's write grant says".
- `fs_move` asks at the floor when `replace` is true, or when `from` is a folder, where a delete
  there would ask. `replace: true`
  means something stands at the landing, and the move replaces it. A file or link replaced gets its
  own ask, and its reason names it. A folder replaced is removed whole, so it asks as a recursive
  delete does: under `delete-tree:` for that path, naming how many files and folders it holds,
  with the same 10,000-entry bound (`FOLDER_TOO_LARGE`). It is checkpointed like a recursive
  delete, and the move lands only after the ask. Otherwise the move asks as a write to `to`'s
  folder does: the first write into a directory asks, and a grant is remembered. Its removal of
  `from` is judged as a write to `from`'s folder.
- A write that empties an existing file, or leaves it under half its size, asks when the session
  has not seen that file lately. The writing tools are `fs_write`, `fs_write_batch`, `fs_patch`,
  `fs_apply_patch`, and `fs_receive` over an existing file. The reason reads "Writing ... empties
  a file this session never read", or "shrinks a file this session never read to under half its
  size".
- A call that rewrites more than 10 existing files at once asks: "This call rewrites N existing
  files at once".
- In a shell, a plain `rm` asks as "Delete of several files" when a target holds a glob character
  (`*`, `?`, or `[`), quoted or not, a brace group of choices or a range, a variable, a command
  substitution, or find's `{}`; when it has two or more targets; and when xargs feeds it. `rm file`
  with one literal path does not ask here. `rm -r` and `rm -f` still ask at the command floor.

## What the session has seen

The session has seen a file when `fs_read`, `fs_read_batch`, or a `fs_search_content` match
reached it, or when the session wrote it itself. A partial read, with `offset` or `limit`, counts.
A sighting follows a file that is moved, and is forgotten when a file is deleted, or when another file
is moved onto its path. A sighting holds for one hour. Each session keeps at most 10,000 paths, and Buckle keeps at most
1,000 sessions, forgetting the least recently used first. The record is in memory only, so a
restart forgets it, and the first such write after a restart asks. Another session's reads do not
count for this one. The thresholds, half the size, 10 files, and one hour, are fixed in this release.

## Scopes and grants

- The file floor offers `once`, `session`, and `always`. With `BUCKLE_STRICT_WRITES=true` it
  offers `once` alone. The command floor offers `once` and `session` only.
- A grant on `delete:<folder>` covers the entries directly in that folder, matched exactly. It
  never covers a folder beneath it.
- A folder removed whole asks under `delete-tree:<path>`, and its grant covers that one removal.
- A delete outside the workspace's folder also offers `delete-below:<folder>`, every delete in
  that folder and its subfolders, and the guard asks under `delete-batch:<folder>`
  ([deletes](policy-05.md)).
- The other subjects are `overwrite:<file>`, for the destructive-write check on one file, and
  `rewrite-batch:<folder>`, for a batch. A folder's write grant never matches any of these.
- `buckle grants list` shows the grants, and `buckle grants revoke <id>` removes one.

## Refused, not asked

- Deleting, moving, or replacing the workspace folder, a mount's source, a folder that holds one of them, a
  read-only mount's source, or a folder that holds Buckle's state, by any spelling the volume
  reads as the same name, so `C:/ws/PROJ` is `C:/ws/proj` on Windows and macOS. A folder holding Buckle's state
  is refused with "The folder holds Buckle's own state and policy, which no tool removes or moves".
- A folder with entries, without `recursive: true`, is refused as `FOLDER_NOT_EMPTY`, before any
  ask. So are a socket, a device, and a pipe, and a recursive delete of a folder that holds an
  entry named with a backslash on Linux or macOS (`FOLDER_NOT_REMOVABLE`).
- A move whose `replace` does not match its landing: `replace: true` with nothing there
  (`NOTHING_TO_REPLACE`), `replace: false` with anything there (`TARGET_EXISTS`), or a replaced
  folder that holds the source. Each is refused before any ask.
- A `deny` on `fs_write` also denies `fs_delete`, `fs_move`, and `fs_apply_patch`, as the tool
  policy maps it. `allow-tool fs_write` lifts it; `allow-tool` on one of the three does not.
- A filesystem `deny` rule beneath a folder removed whole denies that delete. An `ask` rule
  beneath it asks once. A folder moved whole also meets the read rules beneath it, and its
  landing the write rules beneath that path, so a move never passes a rule a direct call meets.

## Dangerously allow

Inside the workspace folder, the [dangerously-allow switch](approvals.md#dangerously-allow)
answers the file floor as it answers `rm -r`. Outside that folder, and in a scratch root, a
person still decides.

The [decision AI](judge.md) never rates these asks. A person decides each one.
