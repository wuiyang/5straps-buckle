# Known limits, part eight

What Buckle, the approval and sandbox runtime on this machine, does not yet cover in its file
tools: delete, move, patch, the destructive-write check, and search without `rg`. [Part
seven](known-limits-07.md) covers the decision AI, and [the file floor](policy-04.md) says what
asks.

## What the file tools leave alone

- An access ACL on a replaced or moved file is not kept, as for every write. Modes are kept.
- A move checks what stands at `to` against `replace`, then renames. A process outside Buckle that
  creates `to` between those two steps is not detected. A replaced entry is renamed aside and removed
  once the move stands; if a folder's removal stops part way, the answer is `ok` and `leftOver`
  names what remains.
- A move across devices or mounts copies the file, then removes the source. The copy is whole
  before the removal, but the two steps are not one change. If the removal of a folder stops part
  way, the answer is `ok` with `leftOver` naming what remains. Times are not kept, and links copy
  as links. On Windows an absolute folder link is made as a junction, any other folder link or a
  file link needs Developer Mode or an administrator, and without either that link is refused by
  name. Where the move fails after the copy, the copy is removed and a replaced file is put back; what
  could not be undone is named, and a file set aside is kept as `.buckle-aside-...` beside it.
- A rename refused with `EPERM` or `EBUSY` is read as a held file on Windows alone. Elsewhere the
  code is reported as it is.
- A move refuses hard links of one file as "the same file". A link that resolves outside a mount
  cannot be moved, though only the link itself would move. The check is conservative.
- A folder of more than 10,000 entries cannot be moved, or replaced by a move, in one call. A delete's count stops at
  10,000 and says "more than". A removal the system refuses, such as a read-only folder, is that
  path's refusal in the answer; a folder removed whole may then be gone in part.
- A delete or a move outside the workspace is checkpointed from the entry alone. A path that does not
  exist yet, such as a move's landing, is checkpointed from the nearest folder that does, which history
  refuses if it holds a hard link, a pipe, or more than 100,000 entries.
- The Windows retry for a held file, and moves across devices, are tested with injected errors
  only. No real Windows node or second device has run them yet.
- The destructive-write check covers the file tools only. A shell command's writes are not
  checked, and they meet only the command floor.
- The check trusts the session's last read of a file for an hour. A change made outside Buckle
  inside that hour is not seen, though a move or a delete through Buckle is. The thresholds, half the size, 10 files, and one hour, are fixed.
- The session's read record is forgotten on a restart. A session id is the caller's own, so a
  caller that changes its id starts with no reads and gets more asks.

## Patches

- A hunk matches its context exactly, with no fuzz. It may sit at any line near its header, and
  its line endings are kept as found.
- Renames, copies, and binary patches are refused. A file may appear once in a patch. A patch
  names at most 100 files and is at most 10 MiB, and a resulting file is at most 10 MiB. A file
  that is not UTF-8 is refused.
- A hunk with less context on one side than the other stands at that end of the file alone, as
  `diff` and `git` write one, so a patch sent twice is refused. A hunk in the middle of a file needs
  the same context on both sides. The search for a hunk's place spends 5,000,000 line comparisons per
  patch, and past that the patch is refused.
- A `diff --git` block with no `---` and `+++` lines creates or removes the empty file it names. A mode
  change is not applied, and a block that holds only one is refused.
- Every hunk of every file is checked before any byte is written. A disk error after the first
  file is written leaves the earlier files written, and the answer lists them. The checkpoint
  covers them. `fs_patch` refuses a file over 10 MiB.

## Search without rg

When `rg` is not installed, `fs_search_content` runs Buckle's own walker. Its results differ from
`rg` in these ways, and the manifest's `limits.searcher` says `builtin`.

- It reads at most 5,000 files, 10 MiB each, and 64 MiB in all, and looks at 200,000 entries.
  Past the file, byte, or entry limit the result is marked `truncated`. A file over 10 MiB is left
  out and counted in `excludedFiles`.
- The pattern runs in a worker thread, so a pattern that backtracks without end cannot stall the
  node. It stops after 5 seconds on one file, or when the call times out or is cancelled, and the
  search fails with "The pattern took more than 5 seconds".
- Globs and ignore files are matched by Buckle's own matcher: case is kept, a backslash escapes
  the character after it, and extended patterns such as `+(a|b)` are not read.
- It skips binary files, those with a NUL byte in the first 8 KiB. `rg` searches them and reports
  their matches.
- It approximates `rg`'s ignore rules. Hidden names are skipped. `.gitignore` is read only inside
  a git repository. `.ignore` and `.rgignore` are read, and a parent folder's ignore files only
  inside the roots and only with slash-free patterns. No global gitignore and no
  `.git/info/exclude` is read. Links are skipped.
- Patterns are JavaScript regular expressions, so a pattern written for `rg` can match differently.
- Output paths use `/` on every platform, where `rg` on Windows prints `.\`.
- It is slower than `rg`, and bounded by the limits above.
