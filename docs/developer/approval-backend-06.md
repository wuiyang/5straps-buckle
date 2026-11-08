# Approval backend: session activity

What tells another process that a workspace's tools still run. The idle end of session approvals
will read it; nothing reads it yet but its tests. The [approval backend](approval-backend.md) page
covers the port. Paths are in `buckle/`.

## The executing mark

`common/services/workspaces/active-work.ts` keeps it beside the active-work marks, in
`<state>/workspaces/<id>/active-work/`.

- **The file:** `executing-<instance>`, named by the runtime's own instance id, a UUID minted as it
  opens, which also names the browser sessions it writes. Never by its pid, so a new process under
  a dead one's pid never refreshes the dead one's mark.
- **When it is held:** from the moment a tool begins to run (`beginRun` in
  `common/services/invocation/invoker.ts`, once its approvals clear and any rated code is read
  again) to a `finally` around the tool, whatever becomes of the result entry, which the log
  service writes or drops. A runtime holds one file however many of its tools run, refreshed
  every 2 s (`ACTIVE_WORK_REFRESH_MS`).
- **When it is not:** a call waiting for a person holds none, and neither does a script while one
  of its calls waits: the script's run (`scriptRun`) lets go of the mark for that wait
  (`ExecutingRun.paused`, in `clearPermissions`). A refusal, a replay of an earlier run, a setup
  read, and a transport wrapper never begin a run.
- **A write that fails:** warned in the node log, never thrown, so a cleared tool runs and answers
  as it ran. A missing mark can only let an idle check end sessions early, and their calls ask
  again.
- **A crash:** a dead process stops refreshing, so its mark reads stale 10 s after its last
  refresh (`ACTIVE_WORK_FRESH_MS`).
- **The reader:** `executingInstances` lists the instances whose mark is fresh, and removes the
  stale ones; a runtime that stalled past 10 s writes its mark again at its next refresh. A folder
  not made yet reads as no tool running. Any other read error throws, which the idle check is to
  take as activity unknown.
- **Kept apart:** `activeElsewhere`, which `disable`, `remove`, and `prune` read, skips executing
  marks. The pid mark it reads is held while any call runs, waits included, so it already covers
  every tool.

## Tests

`test/executing-mark.test.ts` covers the mark on a fake clock, a paused run beside a running one,
a mark a dead process left beside a new process, a second process killed while its run holds the
mark, a mark that cannot be written, and an unreadable folder. Through a runtime, it covers a long tool, a held ask, a result
entry the log service drops, and a script whose call waits for an answer.
