---
name: buckle-forge
description: Commit, revert a commit, push and open or read a pull request from a 5straps Buckle node, under a credential the owner holds. Use when work must reach a branch and a review, instead of running git push or curl through shell_exec.
---

# Buckle forge

```
buckle git commit --message "fix the slug" --paths src/slugify.js
buckle git revert --commit HEAD~1
buckle git push forge-live-check --set-upstream
buckle pr open --head forge-live-check --base main --title "collapse separators"
buckle pr read 7 --include diff --include files
```

## The token is never yours to see

The forge credential is owner configuration. It is injected into git's environment for the one
push that needs it, scoped to the exact origin URL, and sent as a bearer header to the API; it
never appears in a result, an error, a log line, or the remote URL. Do not ask for it, and do not
add it to a remote yourself. Without it the whole pack is withheld, and the manifest says which
variable is missing.

Because git hands its environment to anything it runs, every git call here runs with hooks and
configs disabled: `core.hooksPath` points at an empty directory Buckle owns, the system and
global configs are out of reach, and every repository key that names a program or re-routes a
request is reset: `credential.helper`, `core.askpass`, the signing keys, the editors, the pager,
`diff.external`, and the proxy and TLS keys, at the origin's own URL scope as well as plainly. A
`pre-commit` or `pre-push` hook in the workspace will not run for these tools; run it yourself
with `shell_exec` if you want it.

Two things are refused rather than reset, because config cannot reach them. A repository that
defines a `filter` driver, or gives a committed path a `filter=` attribute, is refused by
`git_commit`: a clean filter is a program `git add` runs, and `filter.<name>.*` is a whole config
section no override can empty. A repository using git-lfs is refused for that reason. Commit
through `shell_exec` instead. And `remote.origin.receivepack` is first-wins in git, so `git_push`
passes `--receive-pack` on the command line, where it does win. For a repository on this
filesystem that is git itself with the same resets as `-c` options, so the destination's own hooks
and program keys do not run either, no gc runs there, and a push to its checked-out branch is
refused.

## What each tool is for

`git_commit` stages exactly the paths you name and commits them. An empty commit is refused with
git's own message, so read it rather than retrying.

`git_revert` makes a new commit that undoes one (`git revert --no-edit`), under the same identity;
it never resets. A merge commit needs `mainline`, the parent whose side the revert keeps (1 for the
branch it was merged into). A dirty work tree or index is refused with git's own message. A revert
that stops on a conflict is aborted, so the repository stands as it was. A repository that defines
a merge driver or a filter is refused, since a revert would run that program. To undo Buckle's own
file changes rather than a commit, use `history_restore`.

`git_push` pushes one branch to `origin`. `force: true` is always refused: rewriting a published
branch is a `shell_exec` decision the destructive-command gate asks about. Only the configured
forge host is pushed to. Submodules are never pushed, whatever the repository's config says. From a
repository in a mount the owner shares read-only, the push is made but no remote-tracking ref or
upstream is written there, and the result's `note` says so. Such a repository whose `.git` is not a
plain folder of its own is refused; push from a clone in the workspace instead.

`pr_open` needs the head branch pushed first. `pr_read` returns state, head and base, and adds
the diff, the changed files or the comments when you ask for them. The diff is capped at 512 KiB
with `diffTruncated` set when the cap is hit.

Findings belong on the ticket, not on the pull request; there is no comment tool here.
