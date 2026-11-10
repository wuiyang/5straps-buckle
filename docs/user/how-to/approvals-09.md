# Approvals: when nobody answers

Buckle, the local permission node that runs an AI agent's tool calls, skips an ask nobody answers
before it runs out. This page covers when that happens, what the agent is told, and what each
place shows. [Approvals](approvals.md) covers what asks.

## When an ask runs out

An ask runs out at the first of two times:

- **Its stated expiry:** ten minutes past the workspace's approval wait, or past the caller's
  longer hint, as its `expiresAt` says.
- **Its lapse:** ten minutes after the last call holding it ended, where it states no deadline or
  its caller left ([asks nobody holds](approvals-03.md#asks-nobody-holds)).

A call that holds an ask keeps it from lapsing however long it waits, and the idle end never
withdraws one ([session end](approvals-07.md)).

## What it becomes

The ask is skipped, with the reason no response. It is not a denial: nothing is granted, nothing
is denied, and no denial is remembered. Its call did not run. The same call sent again asks
afresh, under a new token.

For ten minutes after, an answer to it is refused as `ask_closed`, and `buckle approve` prints:
"This ask was skipped: no response. Nobody answered it before it ran out, so its call did not
run; the call sent again asks afresh". After that its token reads "Approval token is unknown or
no longer waiting".

## What the agent is told

A call still held on the ask answers an error:

```json
{ "code": "APPROVAL_SKIPPED", "retryable": true, "details": { "reason": "no_response" },
  "message": "Nobody answered this call's approval before it ran out, so it was skipped: no response. The call did not run, and this is not a denial; send the call again to ask afresh" }
```

A call that already returned `approval_required` is told nothing more; sent again, it asks
afresh. A withdrawn ask, or a `once` another call spent, still answers `APPROVAL_UNANSWERED`.

## What you see

| Where | What it shows |
|---|---|
| The serve terminal | the question's row ends `[skipped: no response]` |
| `buckle approvals --watch` | `<token> skipped: no response; dropped.` |
| A deadline line, as in `buckle approvals` | `skipped: no response (<time>)` once the time has passed |
| The node log | `Skipped approvals nobody answered before they ran out`, with `reason` `no_response` and the count |

An ask that lapses before its stated expiry ends the row the same way. The process whose update
dropped the ask writes the log line.

## Records

- **The audit log:** one `approval_skipped` result entry per ask, with `detail` `no_response`, and
  `args` naming the token, the reason, and the call it came from ([decision
  records](audit-log-03.md)). `buckle log` shows it.
- **The approval webhook:** a post with `event` `skipped` and `reason` `no_response`. It replaces
  a wait notice still queued for the ask, and nothing replaces it. A wait notice is `skipped` with
  `caller_declined_wait`, `no_approver`, `wait_elapsed`, or `shutdown`, and its ask still waits.

## From earlier builds

- **The webhook:** said `expired`. A notice an older node queued is sent as `skipped` with
  `no_response`.
- **A held call:** answered `APPROVAL_UNANSWERED`, and now answers `APPROVAL_SKIPPED`.
- **The terminals:** the serve terminal said `[timeout]`, `--watch` said `expired; dropped.`, and a
  passed deadline read `expired (<time>)`.
- **An unknown token:** read "Approval token is unknown or expired".

## Receivers and older builds

- **Update the receiver first:** this change breaks a receiver that checks each notice with an
  older `@5straps/protocol`. It refuses `skipped` with `no_response`, because the reason is new,
  and answers HTTP 400 for the whole post, the notices beside it included.
- **What the node does:** it sends a refused post again in halves until the refused notice is
  alone, and the receiver takes the rest. A notice refused on its own, with HTTP 400, 413, or 422,
  is dropped: the receiver will not take it unchanged, so it is never sent again and never fills
  the queue. The node log warns at the first drop and logs the rest at debug.
- **Rolling back:** the queue keeps this end as `expired`, so a build from before this one still
  reads `approvals.json`, a serve still running beside a newer command included. That build sends
  the end as `expired`, as it always did. When it writes the file, it drops the record of why an
  ask left, so for up to ten minutes this build reads such an ask as withdrawn.
