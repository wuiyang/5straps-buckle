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
