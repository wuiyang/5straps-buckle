# Known limits, part eight

What Buckle, the approval and sandbox runtime on this machine, does not yet cover in its file
tools: delete, move, patch, the destructive-write check, and search without `rg`. [Part
seven](known-limits-07.md) covers the decision AI, and [the file floor](policy-04.md) says what
asks.

## What the file tools leave alone

- An access ACL on a replaced or moved file is not kept, as for every write. Modes are kept.
- A move checks that `to` is free, then renames. A process outside Buckle that creates `to`
  between those two steps is not detected.
- A move across devices or mounts copies the file, then removes the source. The copy is whole
  before the removal, but the two steps are not one change. If the removal of a folder stops part
  way, the answer is `ok` with `leftOver` naming what remains. Times are not kept, and links copy
  as links.
- A move refuses hard links of one file as "the same file". A link that resolves outside a mount
  cannot be moved, though only the link itself would move. The check is conservative.
- A folder of more than 10,000 entries cannot be moved in one call. A delete's count stops at
  10,000 and says "more than".
- The Windows retry for a held file, and moves across devices, are tested with injected errors
  only. No real Windows node or second device has run them yet.
- The destructive-write check covers the file tools only. A shell command's writes are not
  checked, and they meet only the command floor.
- The check trusts the session's last read of a file for an hour. A change made outside Buckle
  inside that hour is not seen. The thresholds, half the size, 10 files, and one hour, are fixed.
- The session's read record is forgotten on a restart. A session id is the caller's own, so a
  caller that changes its id starts with no reads and gets more asks.

## Patches

- A hunk matches its context exactly, with no fuzz. It may sit at any line near its header, and
  its line endings are kept as found.
- Renames, copies, and binary patches are refused. A file may appear once in a patch. A patch
  names at most 100 files and is at most 10 MiB, and a resulting file is at most 10 MiB. A file
  that is not UTF-8 is refused.
- Every hunk of every file is checked before any byte is written. A disk error after the first
  file is written leaves the earlier files written. The checkpoint covers them.

## Search without rg

When `rg` is not installed, `fs_search_content` runs Buckle's own walker. Its results differ from
`rg` in these ways, and the manifest's `limits.searcher` says `builtin`.

- It reads at most 5,000 files, 10 MiB each, and 64 MiB in all. Past a limit the result is
  marked `truncated`.
- It skips binary files, those with a NUL byte in the first 8 KiB. `rg` searches them and reports
  their matches.
- It approximates `rg`'s ignore rules. Hidden names are skipped. `.gitignore` is read only inside
  a git repository. `.ignore` and `.rgignore` are read, and a parent folder's ignore files only
  inside the roots and only with slash-free patterns. No global gitignore and no
  `.git/info/exclude` is read. Links are skipped.
- Patterns are JavaScript regular expressions, so a pattern written for `rg` can match differently.
- Output paths use `/` on every platform, where `rg` on Windows prints `.\`.
- It is slower than `rg`, and bounded by the limits above.
