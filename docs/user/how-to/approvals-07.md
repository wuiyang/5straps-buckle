# Approvals: session end

Buckle, the local permission node that runs an AI agent's tool calls, ends a session's approvals
once the session goes quiet, or once the MCP server they were given through closes. This page
covers when that happens, what ends, and how to change the window. [Approvals](approvals.md)
covers the scopes.

## When a session ends

A session is its id under the caller that asked in it: an HTTP call's token, `mcp-stdio`, or the
CLI's owner. A `session` grant lasts until you revoke it with `buckle grants revoke <id>`, or
until its session ends:

- **`buckle mcp`:** each process has a session of its own, `stdio:<id>`, which ends as the process
  exits, whether its client closed it or the node stopped it. Other `buckle mcp` processes on the
  workspace keep theirs, and a restarted MCP server starts a fresh one.
- **HTTP MCP:** `/mcp` keeps no session per client, so every call is named `mcp`, and each token
  has its own session under it. They all end as `buckle serve` stops, and as serve first opens
  the workspace after it starts, so a serve killed before it could stop leaves nothing that
  clears a call. Bringing the workspace back online while serve runs ends none.
- **Idle:** once a session has had no activity of its own for longer than its idle window, 15
  minutes unless you set one, it ends, on every face: the CLI's `cli`, each `buckle mcp` session,
  each HTTP MCP token's, and each HTTP API `context.sessionId` or `rpc`. The workspace's other
  sessions keep theirs, so one agent going quiet ends no other agent's approvals.

The CLI's `cli` and the HTTP API's sessions end at idle alone. An `always` grant never ends with a
session.

A session's activity is:

- one of its tools running, in any Buckle process on the workspace, however long it runs;
- one of its calls starting or ending;
- an ask of its calls being recorded, and a decision on one being applied.

A call waiting for you is not activity, so an ask left unanswered past the window ends with its
session. Neither is a setup read (`buckle workspace show`, `buckle grants list`, the setup routes),
a call refused before it reaches the workspace's rules, such as one with a bad token or to an
offline workspace, nor an audit log record.

Buckle checks a call's own session before the call, so a call after the window finds its
session ended and asks again; every session before each decision; and every session once a minute
while `buckle serve` or `buckle mcp` has the workspace open. A process that saw a session's
activity itself within the window reads nothing of it.

## What ends

- Session approvals and remembered session denials: `buckle grants list` no longer shows them.
- `once` approvals no call has spent yet.
- Session grants decided but not yet saved ([when a grant cannot be saved](approvals-05.md)):
  none is written later.
- Asks still waiting, each withdrawn. A call held on one answers `APPROVAL_UNANSWERED`, the serve
  terminal drops its question, and the approval webhook is told it was `cancelled`. The same call
  sent again asks anew. An answer given after the window, from any process, finds its ask
  withdrawn and grants nothing.

Each session that ends writes one `approval_session_ended` entry in the workspace's audit log,
naming its cause ([decision records](audit-log-03.md)). A session that held none of these writes
none.

## The idle window

```bash
buckle workspace set approval.sessionIdleMs 1800000
buckle settings set approval-session-idle 1800000
```

The window is in milliseconds, `60000` (a minute) to `86400000` (a day), or `0`, which ends no
session at idle; a revoke still ends one. The workspace's own value wins, and `buckle workspace
unset approval.sessionIdleMs` takes it out, so the node's `BUCKLE_APPROVAL_SESSION_IDLE_MS` in
`buckle.env` applies, else `900000`. A workspace's change applies from its next call; the node's
when the node or `buckle mcp` starts. Each running `buckle serve` and `buckle mcp` process ends
sessions at the window it started with, so after you turn the node's value off or make it longer,
restart each of them.

## When Buckle cannot tell

Buckle reads a session's activity from `activity.sqlite` in the workspace's `history/` folder and
from the marks in its `active-work/` folder, which name the sessions whose tools run. Where either
cannot be read, as on a disk error, the session does not end and nothing is deleted. Until it can
be read again, none of the session's approvals clears a call: each asks you again, and one you
give meanwhile does too, so answer `once` to let the call run. A remembered denial still binds.
The node log warns once, naming what it could not read. A store
another Buckle process holds busy past its wait only skips that check: `activity.sqlite` for more
than a second, or the approvals files as the check ends the sessions.

Where `activity.sqlite` holds nothing of a session, as after it was lost, the making of that
session's newest session grant in `grants.json` counts as its last activity, so an old grant still
ends. Where `grants.json` cannot be read then, Buckle cannot tell, as above.

## Limits

- A process killed while its tool runs records no end: its tool stops counting as activity 10
  seconds later, so its session can end soon after.
- A `buckle mcp` process killed outright ends no session: its approvals clear no other process's
  calls, and end when its session idles. A serve killed outright leaves the HTTP MCP sessions
  until a serve first opens the workspace again, or each idles.
- With no call coming, an idle session can outlast its window by up to the minute between checks.
- A session end in one process can meet a call another process is clearing at that moment: the
  call may run on the grant it read just before, or ask again.
- A tool whose process stalls for more than 10 seconds, as on a very large copy on a slow disk,
  can read as idle to another process meanwhile, so its sessions can end sooner, never later.
