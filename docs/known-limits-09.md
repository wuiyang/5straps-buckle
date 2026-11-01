# Known limits, part nine

Limits of Buckle, the approval and sandbox runtime on this machine, on read-only `git_push`, change
history, MCP asks, `buckle cp`, and deletes.
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

## Change history

[The change history](change-history.md) says how checkpoints are made.

- A command's checkpoint in the workspace needs permitted, trusted host Git, which is off by
  default. Without it the command runs and lists no change. File tools' checkpoints need no Git.
- Git keeps file modes as 644 or 755, so restoring a command's change can reset another mode,
  unless an earlier checkpoint recorded it.
- A command's changes under ignored paths are counted, not stored. The count misses a change
  deep inside an ignored folder that already existed. A `.gitignore` above the workspace folder,
  such as a monorepo root's, is not read.
- The first command in a folder hashes every file Git tracks there once; later ones hash only
  what changed. That copy does not count toward `BUCKLE_HISTORY_MAX_BYTES`. A first hash past 30
  seconds leaves its command unrestorable; Buckle finishes it in the background, and commands
  that start meanwhile are unrestorable too.
- A file over `history.maxFileBytes` is compared by size, mode, and mtime. Git still reads such a
  file in a command's folder each time it changes.
- A command interrupted while it runs leaves a checkpoint that is never restorable.
- A shadow-git checkpoint of an earlier build restores only with host Git, and a SQLite one never
  does. Both stores are deleted after `history.keepTurns` turns of new checkpoints.

## Asks over MCP

[Approvals over MCP](approvals-03.md) says how an agent sees an ask and sends the call again.

- `/mcp` over HTTP never elicits, by ruling: its client holds the agent token, so a form answered
  there would be the agent approving its own call. A person answers at the node, with
  `buckle approvals`, or through Rings, the 5straps app a node can pair with.
- Every HTTP MCP client under one token shares the session `mcp` and one actor. Identical calls
  from two such clients count as one call, and their asks share the session's 50. A session per
  client is a follow-up.
- Buckle cannot tell whether a client read an answer. A run that answered later than 30 seconds
  is replayed to an identical call within ten minutes, even one from a client that read it. The
  answer is marked `Replayed`, and the next identical call, or a fresh `5straps/requestId`, runs
  it again. A client whose own timeout is under 30 seconds, and
  that sends no shorter `5straps/approvalWait`, can still miss an answer and ask twice.
- An ask answered `approval_required` that the agent never sends again counts against the
  session's 50 until it lapses or expires; only abandoned asks make room.
- An ask at `approvalWaitMs` `0` from an MCP call or a copy still states no deadline in its
  `expiresAt`, since a person's device signs that field in its challenge; the lapse is kept
  beside it. A decision on a lapsed ask is refused as unknown or expired. `/v1/invoke` asks do
  not lapse at wait `0`, so a run Rings parked keeps its ask until it is answered.
- An ask held until answered keeps no lapse when its node process is killed rather than stopped:
  it waits, as before, until it is answered or withdrawn.
- A copy approved late in its hold has what is left of node:http's 300 seconds for the checkpoint
  and the upload. A run cut there may answer its re-send that its effects are unknown
  (`REQUEST_ALREADY_EXECUTED`), and `buckle cp` then stops; run it again. A node that resets the
  connection instead of answering 408 stops `buckle cp` as an unreachable node does.

## Deletes

- The mass-delete guard counts one call, or all the calls of one script together. An agent that
  deletes 100 entries in each of many direct calls is never asked by it; each call meets the write
  gate alone. A script that stopped at an ask and is sent again counts from that send, as the calls
  it replays do not run again. A folder moved whole is not counted, as nothing of it is removed.
- The wider subject, `delete-below:<folder>`, is not part of the challenge a device key signs, so a
  person's device cannot grant it yet, and Rings at protocol 0.1.7 offers the ask's own subject
  alone. The serve terminal, `buckle approve --below`, and `buckle approvals --watch` grant it.
- MCP elicitation answers `once`, `session`, or `always` for the ask's own subject, and offers no
  wider choice.
- The shell is outside the policy: `rm`, `find -delete`, and the other commands at the command floor
  ask inside the workspace's folder as they did, whatever `files.deleteInWorkspace` says.
