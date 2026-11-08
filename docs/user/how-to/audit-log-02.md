# The audit log, part two

[Part one](audit-log.md) covers the log's file, its entries, and how they are trimmed.

## How it is written

One worker thread in each Buckle process writes its logs and syncs each entry to disk; a call waits
for its entry before it goes on. A slow or stalled disk holds the calls waiting on their entries,
and the node still answers everything else, `GET /health/ready` included. Readiness gives a failing
log one second to prove it takes writes again; a log that does not answer in time still counts as
failing. A node that stops waits 2 seconds for the entries in flight, then logs
`Action log writes left unwritten at close` with their count. An attempt left unwritten stopped its
call, and a call whose result was left unwritten is marked `interrupted` the next time a Buckle
process opens the log.

Each write takes the log's lock, `actions.jsonl.lock.sqlite` beside it, so two Buckle processes
never write into each other's lines. A call that waits more than 5 seconds for another process's
lock does not run, and is refused with `STATE_BUSY`, to retry. A line that a process left half
written when it died is ended and kept, and `buckle log` skips it. A write that failed partway and
is tried again reads back what it already wrote, by each line's `entryId`, and leaves those lines out.

## Sending it elsewhere

With `BUCKLE_REPORT_URL` and `BUCKLE_REPORT_TOKEN` set (Buckle refuses to start with only one),
Buckle also posts each tool call's result entry and each dangerously-allowed use to that URL, with
the token as bearer; the approval webhook sends the token too. A batch holds up to 100 entries and goes
out 5 seconds after its first, or when 100 wait, with up to 3 attempts. The queue holds 500
entries and drops the oldest; a refused call is also posted on its own. A report carries the entry
as the log keeps it, the workspace root, and for a refusal its rule, subject, and reason. Posting
never holds up a call, and an undelivered batch stays in `actions.jsonl`. Both URLs are the
owner's settings, so the egress rules for agent network access do not apply to them.
