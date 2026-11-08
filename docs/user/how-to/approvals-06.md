# Approvals: MCP forms

Buckle, the local permission node that runs an AI agent's tool calls, can ask you about a call in
the agent's own app, as a form, instead of at the node. This page covers turning that on, and what
it changes. [Approvals](approvals.md) covers what asks and the other places to answer.

## Turning forms on

Forms are off unless you turn them on, for one workspace or as every workspace's default:

```bash
buckle workspace set approval.forms on
buckle settings set approval-forms on
```

The workspace's own value wins; `buckle workspace unset approval.forms` takes it out, so the
node's applies again, else off. The node's default is `BUCKLE_APPROVAL_FORMS` in `buckle.env`,
read when the node or `buckle mcp` starts, never from an MCP config's `env`. `buckle workspace
show` names where the value in force comes from.

## What forms do

With forms on, Buckle answers a call that needs a person with one form per ask, for a client
that declares form elicitation, as Claude Code does: `buckle mcp` over stdio, and `/mcp` over
HTTP for a client of the 2026-07-28 MCP revision. The form shows the whole action, as the serve
terminal does. Your answer travels back with the same call sent again, and decides the ask. A
form grants the ask's own subject alone: a folder and its subfolders, or a host pattern, are
granted at the node.

- **Over stdio and HTTP alike:** `once`, `session`, or `always`, as the ask offers them, floor
  asks included: `sudo`, the destructive list, and the file floor. A destructive command still
  never takes `always`. Over HTTP, a client of an earlier revision gets the text instead.
- **A grant that cannot be saved:** where a `session` or `always` answer's grant cannot be
  saved, a save form asks to retry or skip it before the call runs ([when a grant cannot be
  saved](approvals-05.md)).
- **A dismissed form:** decides nothing, and the call sent again draws it again. You may answer
  at the node instead at any time.

With forms off, the call is answered with the text that names the commands to approve it
([approvals over MCP](approvals-03.md)), and any answers a call carries are not read.

## Changing it

Buckle reads the workspace's value at each call, and again as it decides each answer, so a change
with `buckle workspace set` needs no restart of `buckle mcp`. The node's default is read as
`buckle mcp` starts: a change with `buckle settings set` reaches a running one only when its MCP
client starts it again, so stop forms at once with `buckle workspace set approval.forms off`.
For the workspace's value:

- **Turned on:** the next call draws a form, for an ask already waiting too.
- **Turned off:** a form already on screen decides nothing, and neither does an earlier form
  answer sent again, a retry of a save it left, or a skip of one. `buckle mcp` does not read the
  answers a call carries while forms are off; one that reaches the node's approvals all the same,
  sent as the setting changed, is refused as `approver_not_allowed` and recorded in the
  [audit log](audit-log.md).
- **What forms approved before stays:** a grant until you revoke it with `buckle grants revoke`
  or its session ends, and one not yet saved is written by the next decision or when the
  workspace opens again ([when a grant cannot be saved](approvals-05.md)).

## Who can change it

The setting lives in the workspace's `workspace.json`, in the state directory, and in
`buckle.env`, or the file `BUCKLE_ENV_FILE` names wherever it lies. `buckle init`, `buckle service
install`, and each serve record such a file in the state directory, so every Buckle process on the
node knows it, a `buckle mcp` whose own environment names none too, and one already running from
its next call ([known limits](../caveats/known-limits-11.md)). No tool reaches either: the
file tools, code mode, the browser, a secret reference, and a history restore refuse them as
Buckle's own state, and the sandbox hides them from shell commands, so an agent cannot turn forms
on by running `buckle settings set` itself. With `BUCKLE_SANDBOX=none`, a shell command you allowed
reaches any file your user can, these included.

## What a form proves

A form proves the channel, not a person: the app the agent runs in draws it and sends its answer
back. Over stdio, an answer may decide any ask waiting in the workspace, whichever agent's call
raised it. Over HTTP, it decides only the asks its own agent token raised, an answer to any
other ask is not read, and the [audit log](audit-log.md) names that token; every client under one
token counts as one. Anything holding that token can send an answer, so an agent that reads its
own MCP config could approve its own asks, floor asks and `session` or `always` included. Turn
forms on for a workspace whose agent app you trust to show you each form unchanged. Answers at
the node, with `buckle approvals`, stay open to you whichever way the setting is.
