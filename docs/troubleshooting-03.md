# Troubleshooting: file calls

The refusals and asks the file tools give, with the message Buckle prints and the fix. A file
tool names its refusal in the message, and the result carries a code the agent can read. A batch
of `fs_delete` stops at its first refusal and lists the rest as `notAttempted`. A missing path is
reported as `missing`, and does not stop the batch. [Refused commands](troubleshooting-02.md)
covers the shell.

## Refused

| The message says | Code | Fix |
|---|---|---|
| "Something already stands at ...: send replace: true to replace it" | `TARGET_EXISTS` | send `replace: true`, or move to a free name |
| "... is a folder, and a move replaces a file, never a folder" | `TARGET_EXISTS` | delete the folder first, or move into it by name |
| "The folder ... does not exist, and a move makes no folder" | `PARENT_MISSING` | create the folder first |
| "... is a folder that holds entries: send recursive: true" | `FOLDER_NOT_EMPTY` | send `recursive: true`, after reading the ask's count |
| "... holds more than 10000 entries, more than one checkpoint covers" | `FOLDER_TOO_LARGE` | move the folder in parts |
| "... is held open by another program" | `ENTRY_HELD` | close the program, then send the call again; on Windows, a read-only file also gives this |
| "There is no file or folder at ..." | `FILE_NOT_FOUND` | check the path |
| "The folder holds Buckle's own state and policy" | `PERMISSION_DENIED` | choose another folder; no tool reaches Buckle's state |
| "Hunk N of ... does not match the file, so nothing was written" | `PATCH_DOES_NOT_APPLY` | the header names the hunk; rebuild the diff from the file as it stands |
| "The patch creates ..., which exists already" | `PATCH_DOES_NOT_APPLY` | diff against the file that exists, or use a free path |
| "... now lands where its permission check did not see" | `PERMISSION_DENIED` | the path changed between the check and the write; send the call again |

A patch writes nothing when any hunk fails. A delete that refuses a path lists every path in
order, so the agent can see which ones went.

## Asks

These are asks, not refusals. They wait for a person, as [approvals](approvals.md) describes.

- "Deleting ... always asks a person, whatever the folder's write grant says": the person
  approves once, for the session, or always. No grant on the folder is enough.
- "Writing ... empties a file this session never read", or "shrinks a file this session never
  read to under half its size": read the file with `fs_read` first. A read within the hour lets
  the write run without this ask.
- "This call rewrites N existing files at once": split the work into calls that rewrite 10
  existing files or fewer.
- "Delete of several files", from a shell `rm`: name one literal path in each `rm`. `rm` of one
  literal path does not ask here.

A restart forgets what the session has read, so the first such write after a restart asks
again. [Policy: the file floor](policy-04.md) gives the full rules.
