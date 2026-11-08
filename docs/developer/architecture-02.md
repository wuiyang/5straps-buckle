# Architecture: state and packs

The second part of [Architecture](architecture.md). Paths are inside `buckle/` unless they start
with `packages/`.

## Workspaces

`common/services/workspaces/registry.ts` keeps `workspaces.json`, version 2: each workspace's id,
name, folder, whether it is online, and its agent tokens as SHA-256 digests, compared in constant
time across every workspace (`workspace-manager.ts`, `tokenOwner`). `workspace-settings.ts` keeps
each one's `workspace.json`; `config.ts` composes a runtime's configuration from the node's
settings and the workspace's (`workspaceConfig`). `migration.ts` moves a 0.1 node onto them once.
`/mcp` and `/v1/*` take the workspace from the bearer token (`layers/common/server/utils/guards.ts`).

## The approval registry and its state files

`common/services/approvals/approval-registry.ts` keeps each workspace's queue in its state
directory:

| File | Holds |
|---|---|
| `approvals.json` | pending asks, recent decisions with each lasting approval's grant id and save state, unspent `once` approvals, and undelivered webhook notices |
| `approval-calls/<uuid>.json` | the whole call of each request group, written once however many asks it made |
| `approval-revocations.json` | revokes and session ends not yet finished: made while `approvals.json` was unreadable, or whose grants still stand. Approvals they name clear nothing; the next decision, ask, spent once, or opening finishes them, then deletes it. While it is damaged, those are refused and no session approval clears a call |
| `grants.json` | `session` and `always` grants and remembered denials (`common/adapters/grant-store/file-grant-store.ts`) |

Every file goes through `common/adapters/json-file-store.ts`: a write is an atomic rename,
and an update holds a cross-process lock in `<file>.lock.sqlite`, waiting up to 5 seconds before
answering `STATE_BUSY`. The action log's writer worker takes the same lock (`withFileTurn`) around
each batch's tail check, append, sync, and pending update; a batch tried again first reads back,
by `entryId`, from where its failed attempt on that file began, as best effort. `approval-service.ts` is the single answerer
every route calls. It polls the queue every 400 ms, so an answer `buckle approve` writes from
another process wakes the waiting call. One session may keep 50 asks waiting and one workspace 500.

An owner's own change (`common/services/audit/audit-operation.ts`, and the setup and registry audits
in `layers/admin/server/utils/audit.ts`) waits for its attempt as a call does, while
`OWNER_RECORDS_WAIT` in `common/runtime/log-budget.ts` holds. An attempt that cannot be written
throws `OwnerRecordError`: the CLI prints it with the write's own error and exits 6
(`cli/ignore-warning.ts`), and the setup face answers 503. The owner's `--ignore-warning`, taken in
`main.ts` with the other global flags, or `ignoreWarning=true` in a setup request's query, hands
the attempt to the log service instead (`ActionLog.ownerAttempt`).

## The pack system

A pack (`common/domain/pack.ts`) has an id, tools, skills, an `unavailableReason`, and an
optional `close`. A tool comes from `defineTool` (`common/domain/tool.ts`): a name, a
description, a risk level, a Zod input schema, an `effects` function, and `run`. The manifest's
JSON Schema and the MCP registration both come from that one Zod schema.
`common/services/packs/index.ts` is the only place built-in packs are built, each from its own
directory with a `SKILL.md` beside it; `scripts/build.mjs` copies those into `dist`. A pack with
an `unavailableReason` contributes no tools, so the registry, the manifest, and MCP list only what
runs. Plugins load through `common/adapters/plugin-registry.ts` from modules that export
`createPack(options)`, recorded in `plugins.json`. `defineTool` refuses a name Buckle writes its
own records under (`isRecordTool` in `common/domain/record-tools.ts`): `approval_decision`,
`log_dropped`, `approval_session_ended`, and any starting `cli_`, `setup_`, `workspace_`, or
`policy_`. A plugin with such a tool fails to load, shows as an unavailable pack, and the node's
log names the tool.

The `network_egress` rule and `web_fetch`'s hop check (`services/packs/web/egress.ts`) both take
the workspace's `network.privateRanges`, parsed by `parseCidr` in `common/domain/ip.ts`: an address
`rangeCovering` finds in one is reached without asking. The ranges are a swap input, so a change
rebuilds the packs for the next call.

[Code mode](architecture-03.md), the pack that runs an agent's script, continues on part three.

