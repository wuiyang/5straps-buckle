# The audit log, part two

[Part one](audit-log.md) covers the log's file, its entries, and how they are trimmed.

## How it is written

One worker thread in each Buckle process writes its logs and syncs each entry to disk; a call waits
for its attempt before it goes on. A slow or stalled disk holds the calls waiting on their entries,
and the node still answers everything else, `GET /health/ready` included. While 256 writes wait, a
new call does not run, and is refused with `STATE_BUSY`, to retry. Readiness probes every failing
log at once and gives each one second to prove it takes writes again; a log that does not answer
in time, or has not answered its last probe yet, still counts as failing.

A node that stops waits 2 seconds for the entries in flight, then logs
`Action log writes left unwritten at close` with their count. An attempt left unwritten stopped its
call, and a call whose result was left unwritten is marked `interrupted` the next time a Buckle
process opens the log. A disk that stopped answering can hold the writer in the kernel: Buckle then
logs that the writer is held in a disk call, and the process exits once the disk answers, or when
the service manager ends it.

Each write takes the log's lock, `actions.jsonl.lock.sqlite` beside it, so two Buckle processes
never write into each other's lines. A call that waits more than 5 seconds for another process's
lock does not run, and is refused with `STATE_BUSY`, to retry. A line that a process left half
written when it died is ended and kept, and `buckle log` skips it. Each line carries its own
`entryId`, so an entry tried again is not written twice. A write a call waits for is not tried
again: an attempt that fails stops its call.

## What waits, and what is queued

An entry an agent's request starts is written before the work goes on: a call's attempt, the
result of a call that did not run, each dangerously-allowed use, an egress hop the switch allowed,
the transport attempt of an `/mcp` POST or a workbench change, workbench entries, and the stdio
transport's entries. When one cannot be written, the call does not run.

Every other entry goes to the log service and never waits: the result of a call that ran, refusals,
transport and setup results, and your own changes (`cli_*` commands,
`policy_dangerously_allow_changed`, `setup_*`, and `workspace_*`). So a broken log never stops
`buckle grants revoke`, `buckle approve`, `buckle policy dangerously-allow off`, or a setup change.
A queued entry may land after a later one that waited, so read entries by `at`.

The queue shares the 30 entries each Buckle process holds with its log lines
([lines that cannot be written](approvals-02.md#lines-that-cannot-be-written)). When another
arrives, the oldest waiting entry is dropped, whichever log it is for. A write that fails is tried
again after 250 ms, 1 s, and 4 s, and then its entries are dropped. The first drop prints one
`Audit log entries dropped` warning on stderr, as JSON. Once the log takes writes again, a
`log_dropped` entry goes first, its `args` holding the count and the time span (`dropped`,
`firstAt`, `lastAt`). A result dropped this way leaves its attempt, which the next process to open
the log marks `interrupted`.

An entry past the 64 KiB limit is queued without its arguments, effects, rules, judge, and detail,
and its detail says so. A command that ends, and a node that stops, wait up to 2 seconds for the
queue, then print `Audit log entries left unwritten at close` with the count. Removing a workspace
with `--purge`, and `buckle workspace prune --yes`, wait up to 2 seconds for it too, so no late
entry makes the deleted records' folder again.

## Sending it elsewhere

With `BUCKLE_REPORT_URL` and `BUCKLE_REPORT_TOKEN` set (Buckle refuses to start with only one),
Buckle also posts each tool call's result entry and each dangerously-allowed use to that URL, with
the token as bearer; the approval webhook sends the token too. A batch holds up to 100 entries and goes
out 5 seconds after its first, or when 100 wait, with up to 3 attempts. The queue holds 500
entries and drops the oldest; a refused call is also posted on its own. A report carries the entry
as the log keeps it, the workspace root, and for a refusal its rule, subject, and reason. Posting
never holds up a call, and an undelivered batch stays in `actions.jsonl`. Both URLs are the
owner's settings, so the egress rules for agent network access do not apply to them.
