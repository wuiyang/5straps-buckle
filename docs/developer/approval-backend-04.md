# Approval backend: MCP forms

How the forms setting reaches a decision. The [approval backend](approval-backend.md) page covers
the port and the guard, and [MCP forms](../user/how-to/approvals-06.md) the setting as an owner
sets it. Paths are in `buckle/`.

## The setting

`approval.forms` in a workspace's `workspace.json`, else `BUCKLE_APPROVAL_FORMS` in the node's
environment file, else `BUILT_IN_SETTINGS.approval.forms`, which is off
(`common/services/workspaces/workspace-settings.ts`). The node's value is in
`WORKSPACE_DEFAULT_KEYS`, so a caller's environment never sets it. The admin HTTP face patches
no setting.

## Where it is read

- **The runtime:** `approvalForms()` resolves the setting from `workspace.json` as it stands, not
  as the last call took it up, so a change applies to an answer at once. A file that will not read
  counts as off, said once per version in the owner's log.
- **The face:** `mcp/server.ts` reads it at each call. Off, the call gets the relay text and its
  `inputResponses` are not read. The forms backend stays open either way, so turning it on needs
  no restart.
- **Core:** the registry takes the same reader as its `live` option and hands `LiveSettings` to
  the guard at each decision and skip. A registry built without one reads forms as off.

## The guard

The `forms` row in `assurance.ts` counts a form answer as a person's; rated `relayed`, it would be
held to a non-floor `once`.

A source kind whose rights row carries `whileFormsOn` decides only while the setting is on
(`common/domain/approval/assurance.ts`). `screenDecision` checks it first, so it runs before the
ledger lock and again at the head of `guardDecision`, before a repeat is read; `guardSkip` checks
it first too. Off, each is `approver_not_allowed`: a first answer, a denial, a repeat, a save retry,
a skip, and a token the ledger does not hold.

A refused answer settles nothing. Grants forms made while the setting was on stay, and an owed one
is written by the next settling pass, at another decision or at `recover()`.

## Claude Code over HTTP

A probe on 2026-11-08 logged the first request Claude Code 2.1.303 and 2.1.300 sent an HTTP MCP
server built on `@modelcontextprotocol/server` 2.3.1: `server/discover` at protocol revision
`2026-07-28`, declaring `elicitation` with `form` and `url`. `test/fixtures/claude-code-http-mcp.json`
keeps the request, and `test/approval-forms-setting.test.ts` draws forms for those capabilities.
