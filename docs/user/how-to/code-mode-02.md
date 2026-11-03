# Code mode, part two

How Buckle, the approval and sandbox runtime on your machine, replays a [code mode](code-mode.md)
script, and the limits of that replay. [Part three](code-mode-03.md) has the limits Buckle holds a
script to, the setting, and how to read a script in the audit log.

## Replay after an approval

Once the person answers, the agent sends the same script again. Buckle recognises it by the
session, the caller, and the script's text; `timeoutMs` may change. It replays the script: each
tool call the first run made gets the result it got then, read from a record Buckle kept, without
running again. The script then reaches the call that asked, which now runs with the person's
answer, and carries on. A script is deterministic for this: its clock and random numbers repeat
its first run's, and its calls still name its first `code_run` call as their parent.
`describeTool` and `searchTools` are answered from the script's own tool list as its first run had
it, whatever the tool policy says since, and leave its clock where it was. The record keeps only
their numbers and arguments, so a replay that calls them otherwise is refused before anything runs. A call refused or failed
with a retryable error once the script stopped at an ask is made again on the re-send, and a turn
asking more than a session's 50 pending asks asks again for the rest.

## Replay after a stop

A script stopped by its deadline, a cancel, a shutdown, or a failure of its sandbox keeps the same
record of the calls that finished. Sent again within ten minutes, after a restart too, it goes on
where it stopped, and none of those calls runs twice. To run such a script from
its start, change one character of it, even in a comment. Buckle writes the record when the script
stops, so a crash or kill of the Buckle process mid-script loses the calls since its last stop, and
the next unchanged send runs them again.

A call still running when the script stopped is in the record only if its tool had begun to run.
Every unchanged send for ten minutes, after a restart too, then gets `REQUEST_ALREADY_EXECUTED`
for it, its effects unknown, and Buckle does not run it again. A call cut before its tool ran, such as one
waiting for a person, is made again.

Each call in the answer has a status: `ok`, `error`, `cancelled` when the script's end or a stop cut
it, or `skipped` when it never started.

A script that returns, throws, or calls `exit()` leaves no record, and sending it again runs every
call again, unless its replay handed it a call that ran as `REQUEST_ALREADY_EXECUTED`. Its record
then stays until it expires, so no unchanged send in those ten minutes repeats a call.

## Limits of the replay

- The record is kept for ten minutes. Sent later, the script runs from its start, and the calls
  that ran before run again.
- A script whose results pass 32 MiB cannot be resumed, but its calls are not repeated: the
  record keeps them without their results for ten minutes, and every unchanged send in that time
  gets `REQUEST_ALREADY_EXECUTED` for each. At an ask, `code_run` answers `CODE_REPLAY_TOO_LARGE`
  and withdraws the asks. A workspace keeps 128 MiB of records: the oldest go first, the record
  just written last.
- Without its record, only the Buckle process remembers, in memory and for ten minutes, which of
  a script's calls ran: the script sent again gets `REQUEST_ALREADY_EXECUTED` for those, or
  `CODE_REPLAY_DIVERGED` for a call whose arguments read the clock or a random number, since the
  send starts a fresh clock and seed. A restart forgets them, and
  once a send has ended on that error, the next unchanged send runs every call again.
- A script that, replayed, makes other calls than its earlier run did is refused with
  `CODE_REPLAY_DIVERGED`. The record holds every call number an earlier run gave out, including a
  call that asked or was cut, so the first call that differs is refused before it runs. The asks are
  withdrawn and the record kept until it expires, so no unchanged send in those ten minutes runs a
  call of an earlier run twice. Change the script to run it from its start.
- A changed script is a new script: nothing is replayed for it.

Records live in `code-journal/` in the workspace's state directory, owner-only, which every
sandbox hides. Buckle deletes expired ones when it starts and whenever it writes one.
