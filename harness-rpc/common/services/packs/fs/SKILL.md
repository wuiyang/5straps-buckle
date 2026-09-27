---
name: buckle-fs
description: Read, write, patch, and search files on a 5straps Buckle node. Use when working with files on a machine reached through Buckle rather than the local filesystem.
---

# Buckle filesystem

Reads are free inside the workspace. Anything outside it, and every first write to a
directory, returns `approval_required`. Relay the question to the person driving you and
retry once they approve.

Where the node names its workspace `/workspace`, or another virtual root, that root and the
scratch directories beside it are all there is. A path outside them is refused rather than
asked, symlinks followed, so there is nothing to relay and nothing to retry: name the file
under the root instead.

## Reading

```
buckle fs read src/app.ts
buckle fs read src/app.ts --offset 200 --limit 100    # page a large file by line
buckle fs read-batch src/a.ts src/b.ts
```

`fs_read` returns `totalLines`, so page rather than pulling a whole large file into context.

## Writing

```
buckle fs write notes.md --content "..."
buckle fs patch src/app.ts --old "const x = 1" --new "const x = 2"
```

`fs_patch` requires each `oldText` to match exactly once unless `replaceAll` is set, and
writes nothing if any edit fails to match. Prefer it over `fs_write` for edits, because it cannot
silently clobber a file that changed underneath you.

## Finding things

```
buckle fs list src --depth 2
buckle fs find-names "**/*.test.ts"
buckle fs search-content "createInvoker" --glob "*.ts"
```

`fs_list` and `fs_find_names` skip `node_modules`, `.git`, `dist`, and similar by default;
pass `includeIgnored` when you actually need them. `fs_search_content` respects `.gitignore`
and is only present when ripgrep is installed on the node.
