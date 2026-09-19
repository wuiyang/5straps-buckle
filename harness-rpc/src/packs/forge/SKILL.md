---
name: buckle-forge
description: Commit, push and open or read a pull request from a 5straps Buckle node, under a credential the owner holds. Use when work must reach a branch and a review, instead of running git push or curl through shell_exec.
---

# Buckle forge

```
buckle git commit --message "fix the slug" --paths src/slugify.js
buckle git push forge-live-check --set-upstream
buckle pr open --head forge-live-check --base main --title "collapse separators"
buckle pr read 7 --include diff --include files
```

## The token is never yours to see

The forge credential is owner configuration. It is injected into git's environment for the one
push that needs it and sent as a bearer header to the API; it never appears in a result, an
error, a log line, or the remote URL. Do not ask for it, and do not add it to a remote yourself.
Without it the whole pack is withheld, and the manifest says which variable is missing.

## What each tool is for

`git_commit` stages exactly the paths you name and commits them. An empty commit is refused with
git's own message, so read it rather than retrying.

`git_push` pushes one branch to `origin`. `force: true` is always refused: rewriting a published
branch is a `shell_exec` decision the destructive-command gate asks about. Only the configured
forge host is pushed to.

`pr_open` needs the head branch pushed first. `pr_read` returns state, head and base, and adds
the diff, the changed files or the comments when you ask for them. The diff is capped at 512 KiB
with `diffTruncated` set when the cap is hit.

Findings belong on the ticket, not on the pull request; there is no comment tool here.
