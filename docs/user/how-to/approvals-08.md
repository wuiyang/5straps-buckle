# Approvals: when Buckle cannot tell

Buckle, the local permission node that runs an AI agent's tool calls, ends a session's approvals
once the session goes quiet ([session end](approvals-07.md)). This page covers what Buckle does
where it cannot read a session's activity, and the limits of the idle end.

## When Buckle cannot tell

Buckle reads a session's activity from `activity.sqlite` in the workspace's `history/` folder,
from the marks in its `active-work/` folder, which name the sessions whose tools run or whose
calls wait for you, and from the asks waiting in `approvals.json`. Where any cannot be read, as on
a disk error, the session does not end and nothing is deleted. Until it can be read again, none of
the session's approvals clears a call: each asks you again, and one you give meanwhile does too,
so answer `once` to let the call run. A remembered denial still binds. The node log warns once,
naming what it could not read. A store another Buckle process holds busy past its wait only skips
that check: `activity.sqlite` for more than a second, or the approvals files as the check ends the
sessions. So does a mark whose process has not refreshed it for 10 seconds while that process
still runs, as on a slow disk, for up to 5 minutes.

Where `activity.sqlite` holds nothing of a session, as after it was lost, or a day after its last
activity, or once its agent token opened 4,096 newer sessions, the making of that session's newest
session grant in `grants.json` counts as its last activity, so an old grant still ends. Where `grants.json` cannot be read then, Buckle cannot tell, as above.

## Limits

- A process killed while its tool runs records no end: its tool stops counting as activity 10
  seconds later, or 5 minutes later where the system gave its pid to a new process meanwhile.
- A `buckle mcp` process killed outright ends no session: its approvals clear no other process's
  calls, and end when its session idles. A serve killed outright leaves the HTTP MCP sessions
  until a serve first opens the workspace again, or each idles.
- With no call coming, an idle session can outlast its window by up to the minute between checks.
- A session end in one process can meet a call another process is clearing at that moment: the
  call may run on the grant it read just before, or ask again.
- A tool whose process stalls for more than 5 minutes can read as idle to another process
  meanwhile, so its sessions can end sooner, never later.
- An ask held until answered whose last holding process was killed keeps no lapse, so it is never
  [skipped](approvals-09.md) and keeps its session from ending at idle until you answer it, a
  denial included.
