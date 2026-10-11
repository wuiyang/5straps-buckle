---
name: buckle-git
description: Inspect a git repository on a 5straps Buckle node, returning status, diff, log, blame, and branches as structured data. Use instead of parsing git output from shell_exec.
---

# Buckle git

Read-only inspection returning parsed records, so you never scrape porcelain text.

```
buckle git status
buckle git diff --staged
buckle git log --limit 10 --path src/app.ts
buckle git blame src/app.ts --start-line 40 --end-line 60
buckle git branch
```

`git_status` returns `{ branch, upstream, entries, clean }`. `git_log` returns commit records
with `hash`, `author`, `date`, `subject`.

## Writes go through shell

This pack does not commit, push, or rewrite history. Use `shell_exec` for that, which means
`git push --force`, `git reset --hard`, and `git clean -f` hit the destructive-command gate
and ask for approval first. That is deliberate.

## The repository's own git config cannot run programs here

Every call runs with the system and global configs out of view, hooks pointed at an empty
Buckle-owned directory, and every repository key that names a program emptied or refused:
`core.fsmonitor`, a pager, an editor, a credential helper, an external diff or textconv driver,
and a clean or smudge filter. A read tool never runs workspace code.

The one visible effect: where a repository defines a content filter, `git_diff` and `git_blame`
show the bytes on disk rather than the converted form, so a Git LFS path reads as its pointer.
