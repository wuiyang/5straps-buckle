# Code mode, part two

How Buckle, the approval and sandbox runtime on your machine, replays a [code mode](code-mode.md)
script, the limits it holds a script to, the setting, and how to read a script in the audit log.

## Replay after an approval

Once the person answers, the agent sends the same script again. Buckle recognises it by the
session, the caller, and the script's text; `timeoutMs` may change. It replays the script: each
call the first run made gets the result it got then, read from a record Buckle kept, without
running again. The script then reaches the call that asked, which now runs with the person's
answer, and carries on. A script is deterministic for this: its clock and random numbers repeat
its first run's, and its calls stay filed under its first run's stage.

## Replay after a stop

A script stopped by its deadline, a cancel, a shutdown, or a failure of its sandbox keeps the same
record of the calls that finished. Sent again within ten minutes, after a restart too, it goes on
where it stopped, and none of those calls runs twice. That is by design. To run such a script from
its start, change one character of it, even in a comment.

A call still running when the script stopped is not in the record, and the script sent again makes
it again. If it had started, Buckle answers it `REQUEST_ALREADY_EXECUTED`, its effects unknown,
rather than running it twice.

A script that returns, throws, or calls `exit()` leaves no record, and sending it again runs every
call again.

## Limits of the replay

- The record is kept for ten minutes. Sent later, the script runs from its start, and the calls
  that ran before run again.
- A script whose results pass 32 MiB cannot be resumed after an ask: `code_run` answers
  `CODE_REPLAY_TOO_LARGE` and withdraws the asks. A workspace keeps 128 MiB of records, dropping
  the oldest first. Without its record, a script sent again within ten minutes gets
  `REQUEST_ALREADY_EXECUTED` for each call that ran, never a second run, and should change.
- A script that, replayed, makes other calls than its earlier run did is refused with
  `CODE_REPLAY_DIVERGED`. Change the script to run it from its start.
- A changed script is a new script: nothing is replayed for it.

Records live in `code-journal/` in the workspace's state directory, owner-only, which every
sandbox hides. Buckle deletes expired ones when it starts and whenever it writes one.

## Limits

| Limit | Value |
|---|---|
| script size | 262144 characters |
| calls per script | 256, counting refused calls and calls before an ask; past it a call fails with `CODE_CALL_LIMIT`, and a script that keeps calling is ended |
| one call's arguments | `BUCKLE_MAX_REQUEST_BYTES` as JSON, 1 MiB by default, as for a direct call; past it the call fails with `REQUEST_TOO_LARGE` |
| calls running at once | 8, and a call past them waits for a free slot |
| memory | 256 MiB per script |
| time | the call's timeout, or `timeoutMs`, up to `BUCKLE_MAX_TIMEOUT_MS`; a wait for a person counts |
| output, and the returned value | 1048576 characters each, keeping the start and the end |
| output lines | 100000 `text()` and console lines, or 16777216 characters in all; past either the script fails with a `RangeError` |
| an error's name, message, and stack | 16384 characters each, keeping the start and the end |
| calls listed in the answer | the first 256, with `callsOmitted` counting the rest |
| scripts at once | 4 per Buckle process, 2 of them per workspace, then `CODE_VM_BUSY`, which may be retried |

A script that waits on something no call can settle fails at once, since there are no timers. A
failure of the sandbox itself reaches the agent as one fixed sentence, and the owner's log holds
the detail, which may name paths on the host.

## The setting

`BUCKLE_ALLOW_CODE=true` is the default. `false` withholds the code pack, and `buckle manifest`
gives the reason; `buckle settings set code off` writes it. Restart every Buckle process after a
change. The setting covers the node; to turn code mode off for one workspace alone, deny `code_run`
in that workspace's tool policy, with `buckle policy deny-tool code_run` on the node's own
workspace.

## Reading a script in the audit log

The `code_run` call is one entry, with the script's size among its arguments, since the log keeps
the shape of arguments, not their text ([The audit log](audit-log.md)). `buckle approvals show
<token>` prints a script that stopped at an ask, while its record is kept.

Each call the script made is an entry of its own, with a `requestId` of `code:<key>:<number>` and a
`stageId` that names the script: the stage the caller gave its first `code_run` call, or else that
call's run, or else its `requestId`. A script resumed after an ask keeps that stage, so
`buckle log --json` lists all its calls together, and the change history groups their writes the
same way, whatever stage the retry carried.

A call answered from the replay record adds no entry: it did not run again. A call answered by
Buckle's re-send records instead, once the replay record is gone, adds one whose detail is
`REPLAYED`.
