# Approval backend: session end and face sessions

What an end removes, the sessions each face holds and when they end, the idle window's settings,
and the tests. [Session activity](approval-backend-06.md) covers activity and the idle check.
Paths are in `buckle/`.

## What ends

`ApprovalRegistry.endSessions(request)` (`SessionEndRequest`) takes `{ sessionId }`, every
caller's session under a face's id, or `{ sessions }` with an optional `due`, of which only those
still due end (`SessionEnding`, `common/types/ports/grant-store.ts`; `{ allSessions: true }` stands
only for a revocations file that cannot be read). It runs under the approvals lock, then the
grants lock:

- withdraws the waiting asks, queuing their `cancelled` notices, and records each departure as
  `cancelled` with reason `session_ended`, in the process and in the ledger's `ended` list, kept
  ten minutes, so the terminal of any process hears it;
- drops the onces no call spent;
- marks the owed and saved lasting grants `dropped`, so the settling pass never writes them;
- removes the session grants, approvals and denials alike (`GrantStore.endSessions`).

Always grants stay. A read without the lock first skips the lock where nothing would end. The end
is recorded in `approval-revocations.json` (`owed`, with `endedAt`) before the ledger commits, and
forgotten once the grants are gone. Where removing them fails, the record stays: the approvals it
names clear no call in any process (`withheld`, read again when the file changes), and the next
decision, ask, once spent, or open removes them (`applyRevocations`), never one made after
`endedAt`. A skip of a grant the end dropped removes it too. Where `approvals.json` cannot be
read, the end is kept as `revoked` and the grants go; the next of those applies it, withdrawing
the asks and onces it could not reach. A revoke is owed the same way. The service then tells the webhook, wakes each caller held
on a withdrawn ask, and records each session through `DecisionAudit.sessionEnded`, one
`approval_session_ended` entry through the log service, naming its actor. The registry's own `grants`
(`LedgerGrants`) has no session end of its own. The causes are `SessionEndCause`: `idle`, and the
face sessions' below.

## Face sessions

`FaceSession` (`common/services/workspaces/face-session.ts`) is the session id a process's own
face names its calls by in each workspace it opens; an end of it reaches every caller's session
under that id. `initializeCommon` picks it by role (`FACE_SESSIONS` in
`common/runtime/initialize.ts`), exposes it as `BuckleCommon.faceSession`, and hands it through
the workspace manager to `createRuntime`, with `firstOpen` true where the manager has not opened
that workspace since the process started (its `opened` set, filled once a runtime opens):

- **`server`:** `SERVE_SESSION`, `mcp` (`HTTP_MCP_SESSION`), which `mcp/http.ts` names every call
  by, as `/mcp` is served stateless, so each token's session is `mcp` under it. Ended at the first
  open, `serve_started` (`endsAtFirstOpen`), once the approval service is built and before any
  call is served, so what a serve killed before its close left clears nothing; an end that throws
  fails the open, which the next resolve tries again. A later open, as after the workspace went
  offline and back, ends nothing. Ended at close, `serve_stopped`.
- **`mcp`:** `stdioSession()`, `stdio:<uuid>`, minted per process, which `serveMcpStdio` passes to
  `createStdioServer`. Ended at close, `stdio_closed`.
- **`cli`:** none; `cli` ends at idle alone.

The close end is the runtime's `endFaceSession()`, which `closeWithOwner`
(`common/runtime/services.ts`) runs for every open runtime at once at the `timers` stage, before
the `waiters` stage settles the other waits, so held callers hear their asks withdrawn. A runtime
dropped while the process runs ends none; serve's next open does. `McpServerOptions.sessionId` is
required, as neither transport names a session.

## Settings

`approval.sessionIdleMs` in `workspace.json`, else `BUCKLE_APPROVAL_SESSION_IDLE_MS` (alias
`approval-session-idle`), else 900000 (`DEFAULT_SESSION_IDLE_MS`). `parseSessionIdle` takes 0 or
60000 to 86400000 (`SESSION_IDLE_BOUNDS`). The runtime reads it from `config` as taken up: a
workspace's value at its next call, the node's as the process starts, so each process ends sessions
at its own window until it restarts.

## Tests

- **`test/executing-mark.test.ts`:** the mark and the sessions it names, a half-written mark, a
  first write that fails, the hold through the checkpoint after the tool, and a call held for an
  answer, a script's call too.
- **`test/face-sessions.test.ts`:** a stdio process's own id on each call, two stdio processes each
  ending its own alone, the CLI ending none, serve ending every caller's `mcp` at its start after a
  crash and at its stop, and none on a workspace brought back online; an end at open that fails
  fails the open.
- **`test/session-idle.test.ts`:** the verdict, the setting at each layer, and the store, per
  session (a call end on a later turn, a busy read); the end through the service: every face's
  grants, onces, owed marks, withdrawn asks and their webhook notices and ledger reason, the
  record and its actor, a caller under the same id kept, a session whose tool runs kept, one
  session checked alone, a tool that starts between the first read and the lock, a second
  process's long tool, a call held for an answer as a second process reads it, activity seen after
  a gap, and unknown or busy activity, one session's alone.
- **`test/session-idle-runtime.test.ts`:** a faked clock through a runtime: two HTTP MCP callers on
  their own windows, a CLI call after idle, a late decision from another process, the sweep, of
  idle sessions alone, a call held with the wait at 0 past the window and its session's end a
  window after the answer, a dropped result, a decision read by another process, what is
  not activity, the grant fallback, window 0, and an unreadable store in one process and in a
  second.
- **`test/approval-ledger-split.test.ts`:** a session ended while `approvals.json` was unreadable,
  whose asks and onces go once it is repaired.
