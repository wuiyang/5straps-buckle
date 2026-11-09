# Approval backend: session activity

What tells a process that a session is still in use, and how it ends once it is not, or once the
MCP server it came through closes, as the owner ruled. A session is its id under its actor
(`GrantHolder`, keyed by `holderKey`), each on its own window, so one agent going quiet ends no
other's. The [approval backend](approval-backend.md) page covers the port, and [session end and
face sessions](approval-backend-07.md) what an end removes, the sessions each face holds, the
settings, and the tests. Paths are in `buckle/`.

## The executing mark

`common/services/workspaces/active-work.ts` keeps it beside the active-work marks, in
`<state>/workspaces/<id>/active-work/`.

- **The file:** `executing-<instance>`, named by the runtime's own instance id, a UUID minted as it
  opens, which also names the browser sessions it writes. Never by its pid, so a new process under
  a dead one's pid never refreshes the dead one's mark. It holds `{ sessions }`, the sessions whose
  tools run or whose calls are held for an answer, written to a `.tmp` beside it and renamed as that
  set changes, so no reader meets it half written.
- **When it is held:** from the moment a tool begins to run (`beginRun` in
  `common/services/invocation/invoker.ts`) to a `finally` around the history wrapper, so through
  the checkpoint after the tool, and before the result entry is written or dropped. A script holds
  it the whole time, its calls' waits included. One file per runtime, refreshed every 2 s
  (`ACTIVE_WORK_REFRESH_MS`); `begin(session)` counts runs and holds per session, and
  `running(session)` says whether this runtime runs one of its tools or holds one of its calls.
- **A call held for an answer:** holds it from the start of its wait to its end, whatever the
  wait, through `holding` in `ApprovalServiceOptions`, which `createRuntime` wires to `begin`. The
  owner ruled (APPROVAL-31) that a wait of 0 is set on purpose, so such a call stays answerable
  however long it waits, and the idle end never withdraws its ask.
- **When it is not:** a call that asks with the wait `none`, and an ask no call waits on, as
  after its hold ended, hold none.
- **A write that fails:** warned once until a refresh lands, never thrown. The refresh timer starts
  before the first write, so a mark whose first write failed is written at a later refresh. A
  missing mark can only end sessions early.
- **A blocked process:** the refresh runs on the main thread, so a tool that blocks it for more
  than 10 s reads as stale to another process meanwhile.
- **A crash:** its mark reads stale 10 s after its last refresh (`ACTIVE_WORK_FRESH_MS`).
- **The reader:** `executingMarks` lists the fresh marks with their sessions, and removes the stale
  ones and stale `.tmp` files. A folder not made yet reads as none; any other read error, or a
  fresh mark that does not parse, throws.
- **Kept apart:** `activeElsewhere`, which `disable`, `remove`, and `prune` read, skips them.

## Last activity

`common/services/history/activity.ts` keeps `activity.sqlite` in the workspace's history folder.
Its `activity` table holds each session id's newest call start and end, for turn grouping. Its
`sessions` table holds each session's own newest `at`, keyed by id and actor (`''` for none): the
invoker's `startCall(holder)` and `finishCall(holder)` move it in the same transactions, whatever
turn the session moved on to, and so does each ask recorded and decision applied, through the
registry's `onActivity(session)` (`ChangeHistory.touchActivity`). A checkpoint's own turn update
moves no session. Each call start drops the rows older than `SESSION_IDLE_BOUNDS.max`, idle under
any window, and the starting actor's own past its newest 4096 (`SESSIONS_KEPT_PER_ACTOR`), so one
token's new session ids never push out another token's row. `latest(session)` reads it; it throws where the store did not open, since the
in-memory fallback knows one process alone, and `ActivityBusyError` where another process held it
past its 1 s busy wait. Where it holds none of the session, the check takes that session's newest
session grant's `createdAt` (`newestSessionGrant(grants, session)`), and names `grants.json` where
that read throws.

## The verdict

`idleVerdict` in `common/domain/approval/session-idle.ts` is pure, for one session: the time, the
window, the process's own `seenAt`, and a reader in; `off` (window 0), `active` as of when, `idle`,
`unknown` naming the store, or `busy` out. Within the window of `seenAt` it reads nothing. A fresh
mark naming the session is active now; its last activity within the window is active as of then;
anything older, or nothing ever, is idle.

## The check

`createSessionIdleCheck` (`common/services/approvals/session-idle-check.ts`) holds one runtime's
state:

- **When:** `invoke` checks the call's own session (`check(session)`) after the settings pickup,
  before the invoker writes the call's attempt entry, so a call refused before the invoker is
  never activity; one the policy refuses counts, as the invoker's `startCall` runs first. The
  approval service checks the asking session before each ask, and every session before each
  decision (`idleCheck`), so a late answer neither lands in nor revives a session that idled. A
  sweep, `check()`, runs every 60 s (`SESSION_SWEEP_MS`) over `ApprovalRegistry.heldSessions()`,
  stopped at the timers close step. Concurrent checks of one session, or sweeps, share one run.
- **The chain:** `seenAt`, per session, moves with a read that found activity, with this runtime's
  own running tool of it, and with `saw(session)` at a call's start and end, an ask, and a
  decision, but only while within the window, so activity after a gap waits for a read of the gap.
- **The end:** the idle sessions go to `ApprovalService.endSessions` as `{ sessions }`, cause
  `idle`, with a `due` that reads each again under the approvals lock: one with a call or tool
  begun since stays.
- **Unknown:** that session does not end. `sessionApprovalsSuspended(session)` is then true, which
  `createApprovalGate` passes to that session's grant reads: none of its session approvals clears
  a call, one given meanwhile included, and a denial binds (`suspendedSessionApproval`).
  `SESSION_APPROVALS_CLEAR_WHILE_UNKNOWN` turns the suspension off. The node log warns once per
  store until no session is unknown. An end that throws counts as unknown too, but for a lock
  another process held past its wait (`isStateBusy`), which counts as busy.
- **Busy:** the end is skipped this time, and nothing is suspended.
