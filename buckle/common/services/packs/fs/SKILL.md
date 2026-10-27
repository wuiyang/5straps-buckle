---
name: buckle-fs
description: Read, write, patch, and search files on a 5straps Buckle node. Use when working with files on a machine reached through Buckle rather than the local filesystem.
---

# Buckle filesystem

Reads are free inside the workspace. Anything outside it, and every first write to a
directory, returns `approval_required`. Relay the question to the person driving you and
retry once they approve.

Where the node names its workspace `/workspace`, or another virtual root, that root, each mount
the manifest names at its own path, and the scratch directories beside it are all there is. A
path outside them is refused rather than asked, symlinks followed, so there is nothing to relay
and nothing to retry: name the file under the root or a mount instead.

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

## Deleting and moving

```
buckle fs delete old-notes.md build --recursive
buckle fs move draft.md docs/            # into docs, keeping the name
buckle fs move draft.md final.md --replace
```

`fs_delete` always returns `approval_required`, even where writes are granted: relay it.
A link is removed, never followed; a folder that holds entries needs `recursive`. A missing
path is reported, not an error. Never empty a file with `fs_write` to get rid of it.
`fs_move` refuses a `to` that exists unless `replace` is set, and makes no folder; moving a
folder, or replacing a file, asks a person as a delete does.

## Finding things

```
buckle fs list src --depth 2
buckle fs find-names "**/*.test.ts"
buckle fs search-content "createInvoker" --glob "*.ts"
```

`fs_list` and `fs_find_names` skip `node_modules`, `.git`, `dist`, and similar by default;
pass `includeIgnored` when you actually need them. `fs_search_content` respects `.gitignore`;
where ripgrep is not installed the node searches by itself, more slowly, with a JavaScript
regular expression, and the manifest's `limits.searcher` says `builtin`.
