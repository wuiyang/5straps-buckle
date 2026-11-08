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

## The files that hold it

`workspace.json` lies in the state directory, and `NodeConfig.environmentFile` names the node's
environment file, there or wherever `BUCKLE_ENV_FILE` puts it (`common/runtime/config.ts`).
`protectedStateRoots` returns both, typed and real, and each route reads that one set: the
`sensitive_path` rule over every effect a tool, a script's call, a browser command, a secret
reference, or a restore makes; the shell's hidden paths, sorted in
`common/services/shell/shell-filesystem.ts` so a file is masked by binding `/dev/null` over it and
a folder by a tmpfs; the workbench terminal; the change history's exclusions; and the mount
checks. With `BUCKLE_SANDBOX=none` a shell command reaches them; the user pages say so beside each
setting.

## Claude Code over HTTP

A probe on 2026-11-08 ran `claude mcp list`, which checks each server's health and calls no
model, against two throwaway HTTP MCP servers on 127.0.0.1, and logged each request as it arrived.
Claude Code 2.1.303 and 2.1.300 sent the same requests, their versions aside.

- **A server on `@modelcontextprotocol/server` 2.3.1, as `/mcp` is:** `server/discover` at
  revision `2026-07-28`, declaring the client capabilities `roots` with `listChanged` and
  `elicitation` with `form` and `url`. Then `subscriptions/listen` for tool changes, held open,
  and `tools/list`. No `initialize`.
- **A server of the 2025 revisions, which answers the `2026-07-28` header with HTTP 400 as SDK
  1.32 does:** the same `server/discover`, then `initialize` at `2025-11-25` with the same
  capabilities, `notifications/initialized`, a GET for a stream, and `tools/list`.

So Claude Code reaches `/mcp` at `2026-07-28`, the revision a tool's `input_required` answer
needs, and `/mcp` offers no other in `supportedVersions`. `test/fixtures/claude-code-http-mcp.json`
keeps the requests. `test/http/mcp-http.test.ts` replays the `2026-07-28` ones against `/mcp`, and
`test/approval-forms-setting.test.ts` draws forms for the capabilities they declare.
