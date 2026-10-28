# Troubleshooting: file calls

The refusals and asks the file tools give, with the message Buckle prints and the fix. A file
tool names its refusal in the message, and the result carries a code the agent can read. A batch
of `fs_delete` stops at its first refusal and lists the rest as `notAttempted`. A missing path is
reported as `missing`, and does not stop the batch. [Refused commands](troubleshooting-02.md)
covers the shell.

## Refused

| The message says | Code | Fix |
|---|---|---|
| "Something already stands at ...: send replace: true to replace it" | `TARGET_EXISTS` | send `replace: true`, which replaces a folder whole, or move to a free name |
| "Nothing stands at ..., so replace: true has nothing to replace" | `NOTHING_TO_REPLACE` | send `replace: false` to move there |
| "... is a folder that holds ..., so replacing it would remove what is being moved" | none | move the source out of that folder first, or name another landing |
| "The folder ... does not exist, and a move makes no folder" | `PARENT_MISSING` | create the folder first |
| "... is a folder that holds entries: send recursive: true" | `FOLDER_NOT_EMPTY` | send `recursive: true`, after reading the ask's count |
| "... holds more than 10000 entries, more than one checkpoint covers" | `FOLDER_TOO_LARGE` | move the folder in parts; for a folder to replace, delete it in parts first |
| "... is held open by another program" | `ENTRY_HELD` | close the program, then send the call again; on Windows alone, a read-only file also gives this |
| "... could not be moved to ... (EPERM)", or "could not be removed (EACCES)" | `PERMISSION_DENIED` | the system refused: check the folder's permissions; a delete lists the paths removed before it |
| "... could not be removed (EIO)", or "could not be moved to ... (EBUSY)" | `REMOVAL_FAILED` or `MOVE_FAILED` | the error is the system's own; a folder removed whole may be gone in part |
| "... has a name Buckle would read as another path, so it cannot be removed by name" | `FOLDER_NOT_REMOVABLE` | remove that entry another way first; nothing was removed |
| "... is a link, and Windows lets only an administrator ... make one" | none | turn on Developer Mode or run with rights to make links, or move the folder without that link |
| "There is no file or folder at ..." | `FILE_NOT_FOUND` | check the path |
| "The folder holds Buckle's own state and policy" | `PERMISSION_DENIED` | choose another folder; no tool reaches Buckle's state |
| "Hunk N of ... does not match the file, so nothing was written" | `PATCH_DOES_NOT_APPLY` | the header names the hunk; rebuild the diff from the file as it stands |
| "The patch creates ..., which exists already" | `PATCH_DOES_NOT_APPLY` | diff against the file that exists, or use a free path |
| "The patch creates ..., but ... is a file, not a folder" | `PATCH_DOES_NOT_APPLY` | use a path whose folders are not files, or remove that file first |
| "Hunk N of ... does not match the file ...: it has fewer context lines at its end than at the other" | `PATCH_DOES_NOT_APPLY` | the hunk stands at an end of the file, and does not: give it the same context on both sides |
| "Hunk N of ... could not be placed within 5000000 line comparisons" | `PATCH_DOES_NOT_APPLY` | split the patch, or send hunks with a line number near their place |
| "... Already written: modified a.txt ..." | as the first part says | read those files again and send only what is left; the change history can restore them |
| "The pattern took more than 5 seconds on one file" | `INVALID_TOOL_INPUT` | search with a simpler pattern; one that repeats a repetition, such as `(a+)+`, can take very long |
| "... now lands where its permission check did not see" | `PERMISSION_DENIED` | the path changed between the check and the write; send the call again |

A patch writes nothing when any hunk fails. A delete that refuses a path lists every path in
order, so the agent can see which ones went. A disk error while a patch is written names the files
already written.

## Asks

These are asks, not refusals. They wait for a person, as [approvals](approvals.md) describes.

- "Deleting ... asks a person, whatever the folder's write grant says": the person approves once,
  for the session, or always. A write grant on the folder is not enough, but a delete grant is.
  Outside the workspace's folder the ask also offers that folder and its subfolders; inside it,
  this ask comes only under `files.deleteInWorkspace ask` ([deletes](policy-05.md)).
- "... removes more than 100 entries at once", "..., at the top of the workspace, asks a person",
  "This call deletes N entries in the workspace at once", or "This script has deleted N entries in
  the workspace so far": the mass-delete guard. Approve it, or raise `files.massDeleteLimit`.
- "Writing ... empties a file this session never read", or "shrinks a file this session never
  read to under half its size": read the file with `fs_read` first. A read within the hour lets
  the write run without this ask.
- "This call rewrites N existing files at once": split the work into calls that rewrite 10
  existing files or fewer.
- "Delete of several files", from a shell `rm`: name one literal path in each `rm`, with no glob,
  brace group, variable, or xargs. `rm` of one literal path does not ask here.

A restart forgets what the session has read, so the first such write after a restart asks
again. [Policy: the file floor](policy-04.md) gives the full rules.
