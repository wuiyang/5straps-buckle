# Approvals: session end

Buckle, the local permission node that runs an AI agent's tool calls, ends a session's approvals
once the workspace goes quiet. This page covers when that happens, what ends, and how to change
the window. [Approvals](approvals.md) covers the scopes.

## When a session ends

A `session` grant lasts until you revoke it with `buckle grants revoke <id>`, or until the
workspace has had no activity for longer than its idle window, 15 minutes unless you set one. An
idle end ends every session of the workspace, on every face: the CLI's `cli`, the MCP session or
`mcp`, and the HTTP `context.sessionId` or `rpc`. An `always` grant never ends with a session.

Activity is:

- a tool running, in any Buckle process on the workspace, however long it runs;
- a call starting or ending;
- an ask being recorded, and a decision being applied.

A call waiting for you is not activity, so an ask left unanswered past the window ends with its
session. Neither is a setup read (`buckle workspace show`, `buckle grants list`, the setup routes),
a call refused before it reaches the workspace's rules, such as one with a bad token or to an
offline workspace, nor an audit log record.

Buckle checks before each call, so a call after the window finds its session ended and asks
again, and once a minute while `buckle serve` or `buckle mcp` has the workspace open. A process
that saw activity itself within the window reads nothing.

## What ends

- Session approvals and remembered session denials: `buckle grants list` no longer shows them.
- `once` approvals no call has spent yet.
- Session grants decided but not yet saved ([when a grant cannot be saved](approvals-05.md)):
  none is written later.
- Asks still waiting, each withdrawn. A call held on one answers `APPROVAL_UNANSWERED`, the serve
  terminal drops its question, and the approval webhook is told it was `cancelled`. The same call
  sent again asks anew.

Each session that ends writes one `approval_session_ended` entry in the workspace's audit log
([decision records](audit-log-03.md)).

## The idle window

```bash
buckle workspace set approval.sessionIdleMs 1800000
buckle settings set approval-session-idle 1800000
```

The window is in milliseconds, `60000` (a minute) to `86400000` (a day), or `0`, which ends no
session at idle; a revoke still ends one. The workspace's own value wins, and `buckle workspace
unset approval.sessionIdleMs` takes it out, so the node's `BUCKLE_APPROVAL_SESSION_IDLE_MS` in
`buckle.env` applies, else `900000`. A workspace's change applies from its next call; the node's
when the node or `buckle mcp` starts.

## When Buckle cannot tell

Buckle reads activity from `activity.sqlite` in the workspace's `history/` folder and from the
marks in its `active-work/` folder. Where either cannot be read, as on a disk error, no session
ends and nothing is deleted. Until it can be read again, a session approval made longer ago than
the window clears no call, which asks you again, while one you gave since clears as usual. A
remembered denial binds whatever its age. The node log warns once, naming what it could not read.

Where `activity.sqlite` holds nothing at all, as after it was lost, the newest session grant's
making counts as the last activity, so an old grant still ends.

## Limits

- A process killed while its tool runs records no end: its tool stops counting as activity 10
  seconds later, so its session can end soon after.
- With no call coming, an idle session can outlast its window by up to the minute between checks.
- A session end in one process can meet a call another process is clearing at that moment: the
  call may run on the grant it read just before, or ask again.
- A call whose end Buckle missed, as when two calls of one session overlap across stages, counts
  from its start, so its session can end sooner, never later.
