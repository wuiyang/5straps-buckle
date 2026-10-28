# Known limits, part nine

What Buckle, the approval and sandbox runtime on this machine, does when `git_push` pushes from a
repository in a mount the owner shares read-only, and what that leaves out.
[Part four](known-limits-04.md#the-forge-pack) covers the rest of the forge pack, and the
[first part](known-limits.md) lists the other limits.

## A push from a read-only mount

- The push runs on a private copy of the repository's git folder, made in Buckle's state directory
  and removed once the push ends, so what git writes beside a push lands in the copy. Git 2.56
  moves the remote-tracking ref of the remote whose push URL is the destination, and writes its
  reflog; neither reaches the repository. The objects are read in place.
- `git_push` never recurses into submodules, from a read-only mount or anywhere else, whatever
  `push.recurseSubmodules` or `submodule.recurse` the repository's config says. No submodule's
  remote, hook, or program is reached, and no ref is written under `.git/modules`.
- The copy holds `HEAD`, `config`, `config.worktree`, `packed-refs`, `shallow`, `refs`, and
  `reftable`. Nothing else in the git folder is copied, so a push reads no other file there.
- A repository whose `.git` is a file or a link, whose git folder holds a `commondir` or `gitdir`
  file, or that has a link at the top of its git folder, directly in `objects`, or under `refs` or
  `logs`, is refused there. So is one whose `config.worktree` includes another file, as git would
  look for that file beside the copy, and one whose git folder holds a pipe, a device, a link below
  `reftable`, or more entries than Buckle copies. Push such a repository from a clone in the
  workspace.
- A copy that cannot be removed is left in the state directory, readable by the owner alone. It
  never replaces the result or the error of the push.
- The refs are read when the copy is made, just before the push. A commit made in the mount after
  that, and before the push ends, is not pushed, though `headSha` in the answer may name it.
