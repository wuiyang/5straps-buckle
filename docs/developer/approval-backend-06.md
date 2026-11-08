# Approval backend: session activity

What tells a process that a workspace is still in use, and how its sessions end once it is not:
as the owner ruled, a session ends once the workspace has had no activity for more than its
window. The [approval backend](approval-backend.md) page covers the port. Paths are in
`buckle/`.

## The executing mark

`common/services/workspaces/active-work.ts` keeps it beside the active-work marks, in
`<state>/workspaces/<id>/active-work/`.

- **The file:** `executing-<instance>`, named by the runtime's own instance id, a UUID minted as it
  opens, which also names the browser sessions it writes. Never by its pid, so a new process under
  a dead one's pid never refreshes the dead one's mark.
- **When it is held:** from the moment a tool begins to run (`beginRun` in
  `common/services/invocation/invoker.ts`) to a `finally` around the tool, whatever becomes of the
  result entry. One file per runtime, refreshed every 2 s (`ACTIVE_WORK_REFRESH_MS`);
  `ExecutingMark.running()` says whether this runtime holds it.
- **When it is not:** a call waiting for a person holds none, and neither does a script while one
  of its calls waits (`ExecutingRun.paused`, in `clearPermissions`).
- **A write that fails:** warned, never thrown. A missing mark can only end sessions early.
- **A crash:** its mark reads stale 10 s after its last refresh (`ACTIVE_WORK_FRESH_MS`).
- **The reader:** `executingInstances` lists the fresh marks and removes the stale ones. A folder
  not made yet reads as none; any other read error throws.
- **Kept apart:** `activeElsewhere`, which `disable`, `remove`, and `prune` read, skips them.

## Last activity

`common/services/history/activity.ts` keeps `activity.sqlite` in the workspace's history folder.
Its `activity` table holds each session's newest call start and end (`startCall` and `finishCall`
in the invoker); its `workspace` row is touched at each ask recorded and each decision applied,
through the registry's `onActivity` (`ChangeHistory.touchActivity`). `latest()` reads the newest
`at` of both; it throws where the store did not open, since the in-memory fallback knows one
process alone. Where it holds nothing, the runtime takes the newest session grant's `createdAt`
(`newestSessionGrant`).

## The verdict

`idleVerdict` in `common/domain/approval/session-idle.ts` is pure: the time, the window, the
process's own `seenAt`, and a reader in; `off` (window 0), `active` as of when, `idle`, or
`unknown` naming the store out. Within the window of `seenAt` it reads nothing. A fresh executing
mark is active now; a last activity within the window is active as of then; anything older, or
nothing ever, is idle.

## The check

`createSessionIdleCheck` (`common/services/approvals/session-idle-check.ts`) holds one runtime's
state:

- **When:** `invoke` checks after the settings pickup, before the invoker writes the call's attempt
  entry, so a refused call is never activity; and a sweep runs every 60 s (`SESSION_SWEEP_MS`),
  stopped at the timers close step. Concurrent checks share one run.
- **The chain:** `seenAt` moves with a read that found activity, with this runtime's own running
  tool, and with `saw()` at a call's start and end, an ask, and a decision, but only while within
  the window, so activity after a gap waits for a read of the gap.
- **The end:** an `idle` verdict calls `ApprovalService.endSessions` with `{ allSessions: true }`,
  cause `idle`, and a `due` that reads everything again under the approvals lock: a call or tool
  that began since keeps every session.
- **Unknown:** no session ends. `sessionsFrom()` then answers the time a window ago, which
  `createApprovalGate` passes to the grant reads: a session approval made before it clears
  nothing, a denial binds whatever its age (`madeBeforeSessionsFrom`). The node log warns once per
  store. An end that throws counts as unknown too.

## What ends

`ApprovalRegistry.endSessions({ ending, due })`, where `ending` is `{ sessionId }` or
`{ allSessions: true }` (`SessionEnding`, `common/types/ports/grant-store.ts`), runs under the
approvals lock, then the grants lock:

- withdraws the waiting asks, queuing their `cancelled` notices, and records each departure as
  `cancelled` with reason `session_ended`, which the terminal hears;
- drops the onces no call spent;
- marks the owed and saved lasting grants `dropped`, so the settling pass never writes them;
- removes the session grants, approvals and denials alike (`GrantStore.endSessions`).

Always grants stay. A read without the lock first skips the lock where nothing would end. Where
`approvals.json` cannot be read, the end is kept among the revocations (`{ allSessions: true }`
or `{ sessionId }`) and the grants go. The service then tells the webhook, wakes each caller held
on a withdrawn ask, and records each session through `DecisionAudit.sessionEnded`, one
`approval_session_ended` entry through the log service. The registry's own `grants`
(`LedgerGrants`) has no session end of its own. The causes are `SessionEndCause`; only `idle` is
used so far.

## Settings

`approval.sessionIdleMs` in `workspace.json`, else `BUCKLE_APPROVAL_SESSION_IDLE_MS` (alias
`approval-session-idle`), else 900000 (`DEFAULT_SESSION_IDLE_MS`). `parseSessionIdle` takes 0 or
60000 to 86400000 (`SESSION_IDLE_BOUNDS`). The runtime reads it from `config` as taken up.

## Tests

`test/executing-mark.test.ts` covers the mark. `test/session-idle.test.ts` covers the verdict, the
setting at each layer, the store, and the end through the service: every face's grants, onces,
owed marks, withdrawn asks, the record, a tool that starts between the first read and the lock, a
second process's long tool, and unknown activity. `test/session-idle-runtime.test.ts` steps a
faked clock through a runtime: a CLI call after idle, a held ask, a dropped result, a decision read
by another process, what is not activity, the grant fallback, window 0, and an unreadable store.
