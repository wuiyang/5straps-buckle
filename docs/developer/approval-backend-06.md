# Approval backend: session activity

What tells a process that a workspace is still in use, and how its sessions end once it is not,
or once the MCP server they came through closes, as the owner ruled. The [approval
backend](approval-backend.md) page covers the port, and [face sessions](approval-backend-07.md)
the sessions each face holds, the settings, and the tests. Paths are in `buckle/`.

## The executing mark

`common/services/workspaces/active-work.ts` keeps it beside the active-work marks, in
`<state>/workspaces/<id>/active-work/`.

- **The file:** `executing-<instance>`, named by the runtime's own instance id, a UUID minted as it
  opens, which also names the browser sessions it writes. Never by its pid, so a new process under
  a dead one's pid never refreshes the dead one's mark.
- **When it is held:** from the moment a tool begins to run (`beginRun` in
  `common/services/invocation/invoker.ts`) to a `finally` around the history wrapper, so through
  the checkpoint after the tool, and before the result entry is written or dropped. One file per
  runtime, refreshed every 2 s (`ACTIVE_WORK_REFRESH_MS`); `ExecutingMark.running()` says whether
  this runtime holds it.
- **When it is not:** a call waiting for a person holds none, and neither does a script while one
  of its calls waits (`ExecutingRun.paused`, in `clearPermissions`).
- **A write that fails:** warned once until a refresh lands, never thrown. The refresh timer starts
  before the first write, so a mark whose first write failed is written at a later refresh. A
  missing mark can only end sessions early.
- **A blocked process:** the refresh runs on the main thread, so a tool that blocks it for more
  than 10 s reads as stale to another process meanwhile.
- **A crash:** its mark reads stale 10 s after its last refresh (`ACTIVE_WORK_FRESH_MS`).
- **The reader:** `executingInstances` lists the fresh marks and removes the stale ones. A folder
  not made yet reads as none; any other read error throws.
- **Kept apart:** `activeElsewhere`, which `disable`, `remove`, and `prune` read, skips them.

## Last activity

`common/services/history/activity.ts` keeps `activity.sqlite` in the workspace's history folder.
Its `activity` table holds each session's newest call start and end (`startCall` and `finishCall`
in the invoker), for turn grouping; its `workspace` row is touched at each call end, whatever turn
the session moved on to, and at each ask recorded and decision applied, through the registry's
`onActivity` (`ChangeHistory.touchActivity`). `latest()` reads the newest `at` of both. It throws
where the store did not open, since the in-memory fallback knows one process alone, and
`ActivityBusyError` where another process held it past its 1 s busy wait. Where it holds nothing,
the runtime takes the newest session grant's `createdAt` (`newestSessionGrant`).

## The verdict

`idleVerdict` in `common/domain/approval/session-idle.ts` is pure: the time, the window, the
process's own `seenAt`, and a reader in; `off` (window 0), `active` as of when, `idle`, `unknown`
naming the store, or `busy` out. Within the window of `seenAt` it reads nothing. A fresh executing
mark is active now; a last activity within the window is active as of then; anything older, or
nothing ever, is idle.

## The check

`createSessionIdleCheck` (`common/services/approvals/session-idle-check.ts`) holds one runtime's
state:

- **When:** `invoke` checks after the settings pickup, before the invoker writes the call's attempt
  entry, so a call refused before the invoker is never activity; one the policy refuses counts, as
  the invoker's `startCall` runs first. The approval service checks before each ask and each
  decision (`idleCheck`), so a late answer neither lands in nor revives a session that idled. A
  sweep runs every 60 s (`SESSION_SWEEP_MS`), stopped at the timers close step. Concurrent checks
  share one run.
- **The chain:** `seenAt` moves with a read that found activity, with this runtime's own running
  tool, and with `saw()` at a call's start and end, an ask, and a decision, but only while within
  the window, so activity after a gap waits for a read of the gap.
- **The end:** an `idle` verdict calls `ApprovalService.endSessions` with `{ allSessions: true }`,
  cause `idle`, and a `due` that reads everything again under the approvals lock: a call or tool
  that began since keeps every session.
- **Unknown:** no session ends. `sessionApprovalsSuspended()` is then true, which
  `createApprovalGate` passes to the grant reads: no session approval clears a call, one given
  meanwhile included, and a denial binds (`suspendedSessionApproval`).
  `SESSION_APPROVALS_CLEAR_WHILE_UNKNOWN` turns the suspension off. The node log warns once per
  store. An end that throws counts as unknown too.
- **Busy:** the end is skipped this time, and nothing is suspended.

## What ends

`ApprovalRegistry.endSessions({ ending, due })`, where `ending` is `{ sessionId }` or
`{ allSessions: true }` (`SessionEnding`, `common/types/ports/grant-store.ts`), runs under the
approvals lock, then the grants lock:

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
`approval_session_ended` entry through the log service. The registry's own `grants`
(`LedgerGrants`) has no session end of its own. The causes are `SessionEndCause`: `idle`, and the
[face sessions'](approval-backend-07.md).
