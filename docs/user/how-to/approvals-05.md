# Approvals: when a grant cannot be saved

Buckle, the local permission node that runs an AI agent's tool calls, keeps `session` and
`always` grants, and remembered denials, in `grants.json` in its state directory. This page covers
what happens when that file cannot be written. [Approvals](approvals.md) covers the scopes.

## An approval

A `session` or `always` approval is recorded first and its grant written after. When the write
fails:

- **The decision stands:** the call that asked still runs, once, as if you had approved it
  `once`. It gets less than you granted, never more.
- **Other calls ask:** the call that asked, sent again, runs on that once until it is spent. Until
  the grant is saved, every other call it would cover asks again.
- **The answer says why:** `Approved for this call; saving it for the session failed:
  permission denied`. The reason names no path.
- **Saving again:** send the same decision again, from the route that recorded it, to try the write
  again, as often as you like. The next decision in the workspace, and the workspace opening again,
  also write it.
- **Skipping:** gives up the `session` or `always` part for good: nothing writes it later, and a
  grant that had saved meanwhile is removed. The call that asked still runs once.
- **Removed meanwhile:** a revoke, the session's end, or a lasting denial in its place drops the
  grant, so a retry answers that it was not saved.

The decision keeps the id its grant is written under, so `buckle grants revoke <id>` finds the
grant once it is saved.

## A lasting denial

A denial for the session or always is written before it is recorded, so a denial is never recorded
without being in force. When the write fails:

- **Nothing is recorded:** the call keeps waiting, and the answer is refused with the code
  `grant_unsaved`. The route warns: `Not denied for the session: saving failed: <reason>; the call
  still waits`.
- **Saving again:** send the same denial again.
- **Skipping:** denies this call once, which writes nothing to the file.

## Retry or skip

Each route that warns asks next what to do:

| Route | Retry | Skip | Otherwise |
|---|---|---|---|
| The [serve terminal](approvals-02.md), `buckle approvals --watch`, `buckle approve` at a terminal | `r` | `s` | any other answer leaves it; the serve terminal and `--watch` ask a lasting denial again |
| `buckle approve` without a terminal | the same command | a denial: `buckle approve <token> --deny`; an approval: the same command at a terminal | exits 5 |
| `buckle client approve` | not yet | not yet | prints the warning, exits 5 |
| MCP forms | not yet | not yet | the node's log warns |

- **Asked again:** a retry that fails again shows the warning and the question again, with no cap.
- **After the question:** the route says `Saved.`, `Skipped: later calls ask again.` (adding
  `It had already saved; removed.` where it had), `Denied this call once; nothing was saved.`,
  `Not saved: its grant was revoked, ...` where it was removed meanwhile, or `Left unsaved`, where
  the grant is written later as above, or the denial is not recorded.
- **A skip whose grant is not confirmed removed:** where the grant had saved and cannot be removed,
  or `grants.json` cannot be read, the route says so and offers `r` to try the removal again. Left,
  the next decision or the workspace opening again removes it.
- **The serve terminal:** the question takes one key once the keyboard rests half a second, and
  closes after a minute unanswered. An approval's question stays open after its call ran; a
  denial's closes with its ask. A CLI tool command asking at its own terminal holds its call until
  the question is answered or closes, then runs it.
- **`buckle approve` exit codes:** 0 once saved, skipped, or denied once, and 5 where the save
  failed and was left or the grant was removed meanwhile. Without a terminal it prints the warning
  and both commands. A tool command whose call waits for approval still exits 3.
- **Devices:** the setup route answers an approval left owed with `grantOwed` and `saveError`, and
  a lasting denial that did not save with 409, `code: grant_unsaved`, and `saveError`. Retry and
  skip on that route come later.

## The reasons

| Reason | What to check |
|---|---|
| `permission denied`, `operation not permitted` | the state directory's owner and modes ([troubleshooting](../caveats/troubleshooting.md#the-state-directory-has-the-wrong-modes)) |
| `the file system is read-only` | the volume holding the state directory |
| `no space is left on the disk`, `the disk quota is used up` | free space on that volume |
| `a disk I/O error` | the disk |
| `another Buckle process holds the file` | another `buckle` command still running; send the decision again shortly |
| `a state file is unreadable or invalid` | `grants.json` or `approvals.json`, which Buckle names in its log |
| `system error <code>` or `an unexpected error` | Buckle's log, which names the error |

Each answer is also recorded in the workspace's audit log
([decision records](audit-log-03.md#decision-records)): an approval with where its grant stands
(`save`), a refused denial with its `code`, a retry as the same decision again, and a skip as
`skip_save`.
