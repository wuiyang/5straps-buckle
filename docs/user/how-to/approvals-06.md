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

With forms on, `buckle mcp` over stdio answers a call that needs a person with one form per ask,
for a client that declares form elicitation, as Claude Code does. The form shows the whole action,
as the serve terminal does. Your answer travels back with the same call sent again, and decides
the ask as an answer at the node would: `once`, `session`, or `always`, floor asks included.

With forms off, the call is answered with the text that names the commands to approve it
([approvals over MCP](approvals-03.md)), and any answers a call carries are not read.

`/mcp` over HTTP draws no forms yet.

## Changing it

Buckle reads the setting at each call, and again as it decides each answer, so a change needs no
restart of `buckle mcp`:

- **Turned on:** the next call draws a form, for an ask already waiting too.
- **Turned off:** a form already on screen decides nothing, and neither does an earlier form
  answer sent again, a retry of a save it left, or a skip of one. Each is refused as
  `approver_not_allowed` and recorded in the [audit log](audit-log.md).
- **What forms approved before stays:** a grant until you revoke it with `buckle grants revoke`
  or its session ends, and one not yet saved is written by the next decision or when the
  workspace opens again ([when a grant cannot be saved](approvals-05.md)).

## What a form proves

A form proves the channel, not a person: the app the agent runs in draws it and sends its answer
back. Turn forms on for a workspace whose agent app you trust to show you each form unchanged.
Answers at the node, with `buckle approvals`, stay open to you whichever way the setting is.
