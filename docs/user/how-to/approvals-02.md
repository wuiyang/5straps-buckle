# Approvals: the serve terminal

Buckle, the approval and sandbox runtime that runs an AI agent's tool calls, asks each question
in place on the terminal running `buckle serve` when its input and its error output are both
terminals. [Approvals](approvals.md) covers what asks, and every other way to answer.

## A question

```
--- 2026-10-21 ---
22:22:00 [info] /mcp request completed (159ms)
22:22:01 [approval] [my-project] action pending approval: run command
[my-project] shell_exec needs approval in workspace my-project
[my-project]   Recursive delete
[my-project]   subject: rm -rf build  # argv sha256 9f2c...
[my-project]   expires in 10m 15s (at 22:32:16)
[my-project]   node:     node-1
[my-project]   workspace: my-project
[my-project]   does:     Run "rm -rf build" in "/workspace"
[my-project]   rule:     destructive_command
[my-project]   subject:  rm -rf build  # argv sha256 9f2c...
[my-project]   reason:   Recursive delete
[my-project]   in:       /workspace
[my-project]   effects:  exec rm -rf build
[my-project]   arguments:
[my-project]     {
[my-project]       "command": "rm",
[my-project]       "args": [
[my-project]         "-rf",
[my-project]         "build"
[my-project]       ]
[my-project]     }
[my-project] (1) approve once  (2) approve this session  (n) deny
[my-project] Your choice: 2
```

The first line of a question carries the time on this device's clock, the `[approval]` tag, the
workspace, and what the tool does in Buckle's own words, never the agent's. Below it come the ask
and the whole action, nothing cut, as every route shows them, with the expiry in local time; the
relayed text, `buckle approvals`, and a person's device keep it in UTC. Every line carries the
workspace's `[<name>]`.

## Choices and answers

The choices number the scopes the rule offers, and no others: the destructive floor offers no
`always`, so it shows no `(3)`, and a sensitive file adds `(ds)` and `(da)`, which deny it for
the session or always. A delete outside the workspace's folder adds `(4)` and `(5)`, which approve
its folder and subfolders for the session or always ([deletes](policy-05.md)). A key counts once the keyboard has rested half a second. The key you type
stays on the row; Enter, or anything not on offer, denies, and the row then ends with `[deny]`.

A question that ends with no answer says why on its row:

| Row ends with | Why |
|---|---|
| `[timeout]` | the ask expired |
| `[no longer waiting]` | it was answered elsewhere, or the agent's call withdrew it |
| `[stopped]` | the node is stopping |

Ctrl-C at a question stops the node, as it does with no question open.
A question whose ask expired while it waited its turn is not shown.

### When a grant cannot be saved

A `session` or `always` answer whose grant could not be written asks once more:

```
[my-project] Approved for this call; saving it for the session failed: permission denied.
[my-project] r retries the save; s skips it, so later calls ask again; anything else leaves it to be saved later.
```

One key answers it: `r` sends the same decision again and asks again if that fails too, `s`
gives up the lasting part, and any other key leaves it to be written later; a lasting denial left
so is asked again. The outcome is logged
below it ([when a grant cannot be saved](approvals-05.md)).

## The log beside it

Log lines read `22:22:00 [info] message`, with a date line when the day changes and one line per
request. A line logged while a question is open is drawn above it, and the prompt again below.
Where stderr is not a terminal, and in the service log, Buckle writes the same events as JSON
lines; `BUCKLE_LOG_FORMAT=json` writes them at a terminal too, and `human` the other way round.
A node with no terminal logs `Approval pending` for each ask it cannot put to anyone, naming the
tool, the rule, the scopes, the workspace, and the command that shows the action, never its
subject; [known limits](../caveats/known-limits-05.md#a-serve-at-a-terminal) lists what the console does not
yet do. Each answer you give here is also recorded in the workspace's audit log
([decision records](audit-log-03.md#decision-records)); a log that cannot be written never holds
up the answer.

### Lines that cannot be written

These lines never hold up a call. An approval question waits at most half a second for the lines
logged before it, and a command that ends waits at most 2 seconds for its own. Each Buckle process
holds at most 30 of them, waiting or being written, together with the audit entries it queues
([the audit log](audit-log-02.md#what-waits-and-what-is-queued)), and when another arrives, a
queued refusal gives way first, then the oldest waiting one is dropped; a line whose write has not
answered within 1 second counts as waiting, and one dropped that way but then written counts as
written. A write that
fails is tried again after 250 ms, 1 s, and 4 s, and then its line is dropped too. The first drop prints one
`Log events dropped` warning on stderr, as JSON. Once writing works again, a `log events dropped`
line goes first, with the count and the time span (`dropped`, `firstAt`, `lastAt`). A node that
stops waits 2 seconds for its last lines, then prints on stderr how many it left unwritten.
