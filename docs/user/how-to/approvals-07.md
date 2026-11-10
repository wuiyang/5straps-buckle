# Approvals: session end

Buckle, the local permission node that runs an AI agent's tool calls, ends a session's approvals
once the session goes quiet, or once the MCP server they were given through closes. This page
covers when that happens, what ends, and how to change the window; [when Buckle cannot
tell](approvals-08.md) covers a store it cannot read, and the limits. [Approvals](approvals.md)
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
- one of its asks waiting for your answer, whether or not a call waits on it, until it is
  answered, withdrawn, or lapses;
- one of its calls starting or ending, and a call's wait for your answer ending;
- an ask of its calls being recorded, and a decision on one being applied.

So a question you are still reading stays answerable, however long you take: the idle end never
withdraws it. With the approval wait at `0`, which you set on purpose, its call waits until you
answer. Over HTTP MCP once its call's 30 seconds are up, and with [forms](approvals-06.md) on, no
call waits on it, and it lapses ten minutes after its call returned ([asks nobody
holds](approvals-03.md#asks-nobody-holds)), skipped with no response ([when nobody
answers](approvals-09.md)). An answer starts the window again. Once none of its
asks waits and none of its tools runs, a session whose last activity is older than the window can
end at the next check.

Not activity: a setup read (`buckle workspace show`, `buckle grants list`, the setup routes), a
call refused before it reaches the workspace's rules, such as one with a bad token or to an
offline workspace, and an audit log record.

Buckle checks a call's own session before the call, so a call after the window finds its
session ended and asks again; every session before each decision; and every session once a minute
while `buckle serve` or `buckle mcp` has the workspace open. A process that saw a session's
activity itself within the window reads nothing of it.

## What ends

- Session approvals and remembered session denials: `buckle grants list` no longer shows them.
- `once` approvals no call has spent yet.
- Session grants decided but not yet saved ([when a grant cannot be saved](approvals-05.md)):
  none is written later.
- Asks still waiting, where the session ends with its MCP server; at idle none waits. Each is
  withdrawn: a call held on one answers `APPROVAL_UNANSWERED`, the serve terminal drops its
  question, and the approval webhook is told it was `cancelled`. The same call sent again asks
  anew.

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
