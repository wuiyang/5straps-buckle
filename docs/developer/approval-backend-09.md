# Approval backend: the executing mark

The mark each runtime holds on disk while one of its tools runs or one of its calls is held for a
person's answer, which every process reads: the session idle check, to tell a long tool or a
question still on screen from a session nobody uses, and the ledger, to start no lapse of an ask
another process still holds. [Session activity](approval-backend-06.md) covers the idle check
that reads it. Paths are in `buckle/`.

## The mark

`common/services/workspaces/active-work.ts` keeps it beside the active-work marks, in
`<state>/workspaces/<id>/active-work/`.

- **The file:** `executing-<instance>`, named by the runtime's own instance id, a UUID minted as it
  opens, which also names the browser sessions it writes. Never by its pid, so a new process under
  a dead one's pid never refreshes the dead one's mark. It holds `{ pid, sessions, asks }`: the
  writer's pid, the sessions whose tools run or whose calls are held for an answer, and the asks
  those calls hold, each by `heldAskName` (the join key hashed, in `common/domain/approval/call-identity.ts`). It is written to
  a `.tmp` beside it and renamed as that set changes, so no reader meets it half written.
- **When it is held:** from the moment a tool begins to run (`beginRun` in
  `common/services/invocation/invoker.ts`) to a `finally` around the history wrapper, so through
  the checkpoint after the tool, and before the result entry is written or dropped. A script holds
  it the whole time, its calls' waits included. One file per runtime, refreshed every 2 s
  (`ACTIVE_WORK_REFRESH_MS`); `begin(session, ask)` counts runs and holds per session and per ask, and
  `running(session)` says whether this runtime runs one of its tools or holds one of its calls.
- **A call held for an answer:** holds it, naming its ask, from before the ask is recorded to the
  end of its wait, whichever way the call goes, through `holding` in `ApprovalServiceOptions`,
  which `assembleRuntime` wires to `begin(session, ask)`. A call that asks with the wait `none`
  holds it while its ask is recorded alone. Its `end` records the session's activity
  (`touchActivity`) before the mark lets go, so no process meets a gap before the invoker records
  the call's end. An ask no call holds is read from the ledger instead ([the
  check](approval-backend-06.md#the-check)).
- **A hold's end:** the last hold in a process on an ask, a call superseded by a re-send that
  would not wait included, lets go inside `holdEnded`, under the approvals lock, before it reads
  the holds left, so of two holds that end at once the second to take the lock reads the first
  gone. A call that fails before its wait, a failed join included, ends its hold the same way,
  naming its ask by `heldAskName`. Any other hold in the process lets go as it leaves the call's
  participants. A re-send with a set wait never brings a lapse nearer, and sets none on an ask
  without one, which another call may hold until answered: the last hold's end starts it.
- **A write that fails:** warned once until a refresh lands, never thrown. The refresh timer starts
  before the first write, so a mark whose first write failed is written at a later refresh. A
  refresh writes the mark whole wherever what it holds now differs from its last write that landed,
  and touches it otherwise.
- **A blocked process:** the refresh runs on the main thread, so a process that blocks it for more
  than 10 s reads as stale. A stale mark whose pid still answers `process.kill(pid, 0)`, `EPERM`
  included, reads as `stalled` for up to 5 minutes (`ACTIVE_WORK_STALLED_MS`), then as dead: a pid
  given to a new process answers too, and that process never refreshes another runtime's mark.
- **A crash:** its mark reads stale 10 s after its last refresh (`ACTIVE_WORK_FRESH_MS`), and dead
  where its pid answers to nothing, or names none, as a mark from before this build.
- **A clock set back:** a mark dated more than 2 s ahead of the reader's clock is as old as that
  process has seen it unchanged (`markStat`), so a dead writer's mark from before the change goes
  after the usual limits, not once the clock catches up. A refresh dates it by the clock again. A
  one-shot reader, such as a CLI process reading once, has seen the mark for no time, so it still
  reads one dated ahead as fresh.
- **The reader:** `executingMarks` lists the fresh and stalled marks with their sessions and asks,
  and removes the dead ones and stale `.tmp` files only as judged (`removedAsJudged`): each is
  moved aside, then removed, or put back where its identity (inode, mtime, and size) changed since,
  as when its writer resumed, and read as fresh. `executingSessions` splits the sessions into
  `running` and `stalled`. `asksHeldElsewhere` gives the asks other runtimes hold; with this
  runtime's own (`heldAsks`), the registry's `held` reads them in `holdEnded`: an ask's lapse
  starts only once no hold on it remains anywhere. A folder not made yet reads as none; any other
  read error, or a fresh mark that does not parse, throws.
- **Kept apart:** `activeElsewhere`, which `disable`, `remove`, and `prune` read, skips them.
