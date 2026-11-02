# Code mode, part three

The limits Buckle, the approval and sandbox runtime on your machine, holds a [code mode](code-mode.md)
script to, the setting that turns code mode off, and how to read a script in the audit log.
[Part two](code-mode-02.md) covers replay.

## Limits

| Limit | Value |
|---|---|
| script size | 262144 characters |
| calls per script | 256, counting refused calls and calls before an ask; past it a call fails with `CODE_CALL_LIMIT`, and a script that keeps calling is ended |
| one call's arguments | `BUCKLE_MAX_REQUEST_BYTES` as JSON, 1 MiB by default, as for a direct call; past it the call fails with `REQUEST_TOO_LARGE` |
| calls running at once | 8, and a call past them waits for a free slot |
| `describeTool` and `searchTools` calls | 10000 per script, apart from the 256; past it the script is ended with `CODE_GLOBAL_LIMIT` |
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

Code mode is on by default in each workspace. `buckle workspace set packs.code off` withholds the
code pack there, and `buckle manifest` gives the reason; it applies once no work is active in the
workspace. `buckle policy deny-tool code_run` refuses the tool instead, through the workspace's
tool policy.

## Reading a script in the audit log

The `code_run` call is one entry, with the script's size among its arguments, since the log keeps
the shape of arguments, not their text ([The audit log](audit-log.md)). `buckle approvals show
<token>` prints a script that stopped at an ask, while its record is kept.

Each call the script made is an entry of its own, with a `requestId` of `code:<key>:<number>`, the
caller's own `stageId`, as a direct call has, and a `parentRequestId` that names the script: the
`requestId` of its first `code_run` call. A script resumed after an ask keeps that parent, so
`buckle log --json` lists all its calls together. The change history groups their writes by the
caller's stage or run, or else by that parent.

A call answered from the replay record adds no entry: it did not run again. A call answered by
Buckle's re-send records instead, once the replay record is gone, adds one whose detail is
`REPLAYED`.
