# Approvals: calls over MCP, and copies

Buckle, the local permission node that runs an AI agent's tool calls, holds a call that needs a
person for a short while, then answers it with the ask. This page says what an agent over MCP
sees then and what it should do, the `_meta` hints a client may send, and how `buckle cp` waits.
[Approvals](approvals.md) covers what asks and where to answer.

## An ask over MCP

`/mcp` over HTTP holds a call that needs a person for the workspace's `approvalWaitMs`, 30
seconds at most; `0`, which elsewhere waits until someone answers, holds it 30 seconds too. An
MCP client times out on its own clock, Claude Code's near a minute, and the work after an
approval counts against it, so the hold ends well inside it. `buckle mcp` over stdio holds the
call for `approvalWaitMs` as before, or answers at once with a form for a host that declares
form elicitation.

An answer within the hold lets the call run, and the agent gets its result. When the hold ends
unanswered, the result is no error (`isError: false`). Its text names each ask, the commands
that show and answer it, and says to send the same call again once it is decided. Its
`structuredContent` is the `approval_required` answer `/v1/invoke` gives:

```json
{
  "outcome": "approval_required",
  "requestId": "0f8b4c52-7a1d-4e3b-9c55-2d6e8f1a3b70",
  "approvals": [{ "token": "...", "rule": "write_scope", "subject": "/srv/site", "reason": "...",
    "tool": "fs_write", "offeredScopes": ["once", "session", "always"], "expiresAt": "..." }]
}
```

## What the agent does next

Relay the ask to the person, wait for them to decide it, then send the same call again. An
identical call is the same tool, the same arguments byte for byte once their keys are put in
order, from the same session (the MCP session id, or `mcp`) and the same actor (over HTTP, the
token it came with). It runs under the requestId the first call was given, so it:

- joins the ask still waiting, and makes no second ask;
- carries on the wait of a call still held, which ends `REQUEST_SUPERSEDED` without running;
- runs once if the ask was approved, or is refused if it was denied;
- answers with the outcome of a run its client missed, audited `REPLAYED`, without running it
  again; a run cut short as its client left answers that its effects are unknown.

A replayed answer says so: its text begins `Replayed: this call already ran (at <time>) for its
approval and was not run again`, and its `_meta` carries `5straps/replayed: true`, since the
client may have read that run already. Send the call once more to run it anew.

A call never runs twice for one decision. Buckle remembers each call that asked, for ten minutes
from its last use and 256 calls per workspace at most. It forgets the call once a call under it
answered its outcome within 30 seconds to a client still connected, so a later identical call
is a call of its own. Its run is kept for the same ten minutes: the answer itself, and once 256
newer calls or the byte budget push that out, a note that the call ran (4,096 notes per
workspace at most), which a call sent again is answered with as `REQUEST_ALREADY_EXECUTED`.

## The `_meta` hints

A tool call's `_meta` may carry:

| Key | Value | What it does |
|---|---|---|
| `5straps/stageId` | text, up to 200 characters | groups the call's changes in the change history |
| `5straps/approvalWait` | milliseconds, `0` for none | shortens the hold; it never lengthens it |
| `5straps/requestId` | a UUID | the call's requestId: the answer carries it, and a call sent again under it joins its ask exactly, as on `/v1/invoke` |

A client with its own timeout under 30 seconds sends a shorter `5straps/approvalWait`. A client
that names its own requestId keeps track of its calls itself, and Buckle remembers nothing for
them. A hint that reads otherwise refuses the call with `INVALID_HINT`, naming the hint, before
anything is asked or run.

## Asks nobody holds

- A client that closes its connection while its call waits leaves the call unrun, audited
  `CALLER_LEFT`. Its ask is marked abandoned: it stays answerable for ten minutes, the time a
  call sent again can join it, then lapses. An explicit cancel over stdio withdraws the asks,
  audited `CALLER_CANCELLED`.
- At `approvalWaitMs` `0` an ask from an MCP call or a copy states no deadline, and lapses ten
  minutes after its hold ended. The same call sent again joins it and starts the ten minutes
  over. An ask on `/v1/invoke`, where Rings parks a run, waits until it is answered.
- When a session's 50 waiting asks, or the workspace's 500, are full, the oldest abandoned asks
  are withdrawn first to make room, and told cancelled. A cap full of asks someone still holds,
  or re-sent, refuses as before.
- With no terminal attached, `buckle serve` logs `Approval pending` for each ask a call made,
  not only its first.

## Copies

`PUT` and `GET /v1/files`, behind [`buckle cp`](copy.md), hold a copy for the workspace's wait,
120 seconds at most, `0` included, so the node answers before node:http cuts a request at 300
seconds. `buckle cp` prints the node's instruction once per ask and one line naming the asks it
waits on, never a token, then sends the same request again under the same requestId, which joins
them. It treats an HTTP 408, from a node that holds longer, the same way, and an ask that expired
is asked again by the next send. It stops once the copy runs or is refused, or at Ctrl-C (exit
130).

[Known limits, part nine](known-limits-09.md#asks-over-mcp) lists what this still leaves out,
elicitation over HTTP among it.
