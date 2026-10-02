# Architecture

Buckle is the approval and sandbox runtime that lets an AI agent work on one machine. This page
maps the code: the three packages, the layers inside Buckle, the path a tool call takes, and
the pieces that decide it. Paths are inside `buckle/` unless they start with `packages/`.

## Packages

| Path | Package | Role |
|---|---|---|
| `packages/protocol/` | `@5straps/protocol` | Zod schemas for everything on the wire: invoke requests and responses, approvals and grants, the workspace policy, the manifest, action reports, signed requests, and sealed envelopes. Depends on `zod` alone. |
| `packages/runtime/` | `@5straps/runtime` | Runtime primitives: a runtime owner that starts services and closes them in stages, async operation scopes, the CLI interaction channel, the JSON logger with credential redaction, SQLite and file locks (`@5straps/runtime/sqlite`), and Nitro adapters (`@5straps/runtime/nitro`). |
| `buckle/` | `@5straps/buckle` | The `buckle` binary: the CLI, the MCP server, and the HTTP server. Depends on the other two. |

## Layers inside buckle/

- `main.ts` is the entry. `selectMode` sends `init`, `settings`, and `client` to commands that
  need no node, `serve` and `mcp` to long-lived services, and everything else to the one-shot
  CLI. Before a node starts, it loads `buckle.env` (`common/runtime/environment.ts`) and builds
  the configuration (`common/runtime/config.ts`).
- `common/` holds what every face shares. `common/runtime/` starts one common runtime per
  process (`initialize.ts`, `services.ts`). `common/domain/` is pure logic: permission rules,
  the command reader, policy, URL patterns, redaction, effects, tools, and packs.
  `common/adapters/` touches the outside world: JSON state files, sandboxes, processes, the PTY,
  webhooks, the GitHub client, and plugins. `common/services/` ties them together: approvals,
  invocation, packs, shell isolation, change history, workbenches, workspaces, audit, and access.
  `common/types/ports/` holds the interfaces adapters implement.
- `cli/` is the one-shot commands: `main.ts` dispatches, and `init.ts`, `settings.ts`,
  `policy.ts`, `approvals-watch.ts`, `terminal-consumer.ts`, `keys.ts`, `client.ts`,
  `workspace.ts`, and `pairing.ts` implement them.
- `mcp/` is the MCP face. `server.ts` registers each available tool and each skill and turns an
  ask into elicitation forms or relay text; `stdio.ts`, `stdio-wire.ts`, and
  `audited-stdio-transport.ts` serve it on stdio; `http.ts` keeps one stateless handler per
  workspace runtime for `/mcp`.
- `server/` is the HTTP face. `setup-server.ts` imports the built Nitro app from
  `.output/server/index.mjs` and binds it to the process's common runtime; `serve.ts` listens on
  `node:http`.
- `layers/` holds the Nitro layers that `scripts/build-server.mjs` builds into `.output`:
  `common` (`/health`, `/v1/*`, and their `/workspaces/<id>/` twins), `mcp` (`/mcp`), and `admin`
  (`/setup`, which answers 404 unless `BUCKLE_EXPERIMENTAL_ADMIN_HTTP=true`; `--no-admin` builds
  without it).

## A tool call, end to end

Every face calls `invoke` on a workspace runtime (`common/services/workspaces/workspace-runtime.ts`),
which hands the call to the invoker (`common/services/invocation/invoker.ts`):

1. The attempt is written to `actions.jsonl`. If that write fails, nothing runs.
2. A re-send of a call already running or finished is answered with that call's outcome.
3. A tool the policy switched off is refused.
4. The tool's Zod schema parses the arguments, and the tool declares its effects: paths to read
   and write, commands, URLs, and a process listing. `resolve-effects.ts` turns each path into its
   real, symlink-followed form.
5. The permission engine judges the effects. On an ask, the approval service records it, holds
   the call as its transport chose, and checks again once answered.
6. The tool runs under its timeout. A call that writes or runs a command runs under the
   workspace's change history, which keeps a checkpoint.
7. The result is written to the log, and reported when a report URL is set.

## The permission engine

`common/domain/permission/engine.ts` runs a list of rules over every effect. The first deny
returns at once; asks are collected; with neither, the call is allowed. Rules see effects only,
never tool names. `buildPermissionEngine` in `workspace-runtime.ts` fixes the order, which is the
security model: `sensitive_path`, the node ceiling's `command_policy` for a registered
workspace, the workspace's `command_policy`, `destructive_command`, `network_egress`,
`process_probe`, `filesystem_policy`, `read_scope`, and `write_scope`. Floor rules run before
scope rules, so a granted directory never unlocks a credential file inside it.
`rules/dangerously-allow.ts` wraps the engine and turns covered asks into allows while the
switch is on; it never touches a deny. Each rule lives in `common/domain/permission/rules/`.

## The command reader

`common/domain/argv.ts` splits shell text the way a POSIX shell does: words, statements,
quoting, substitutions, and heredocs. `common/domain/command-forms.ts` builds every form a call
can run: the call as typed, the command behind each wrapper prefix from a fixed table, each
statement of a shell body, `eval` text, and `find -exec` commands, recursively, within
`READ_BUDGET`, `MAX_DEPTH`, and `MAX_SUBSTITUTIONS`. It reports the first limit it met, so the
destructive rule can ask and the command policy can refuse. `common/domain/command-glob.ts`
matches the owner's globs one word at a time: whole-line for an allow list, prefix for deny
and destructive lists. `test/heredoc-oracle.test.ts` checks the reader against real bash.

## The approval registry and its state files

`common/services/approvals/approval-registry.ts` keeps each workspace's queue in its state
directory:

| File | Holds |
|---|---|
| `approvals.json` | pending asks, recent decisions, unspent `once` approvals, and undelivered webhook notices |
| `approval-calls/<uuid>.json` | the whole call of each request group, written once however many asks it made |
| `grants.json` | `session` and `always` grants and remembered denials (`common/adapters/grant-store/file-grant-store.ts`) |
| `approval-nonces.json` | nonces of sealed decisions, once a Rings key is paired |

Every file goes through `common/adapters/json-file-store.ts`: a write is an atomic rename,
and an update holds a cross-process lock in `<file>.lock.sqlite`, waiting up to 5 seconds before
answering `STATE_BUSY`. `approval-service.ts` is the single answerer every route calls. It polls
the queue every 400 ms, so an answer `buckle approve` writes from another process wakes the
waiting call. One session may keep 50 asks waiting and one workspace 500.

## The pack system

A pack (`common/domain/pack.ts`) has an id, tools, skills, an `unavailableReason`, and an
optional `close`. A tool comes from `defineTool` (`common/domain/tool.ts`): a name, a
description, a risk level, a Zod input schema, an `effects` function, and `run`. The manifest's
JSON Schema and the MCP registration both come from that one Zod schema.
`common/services/packs/index.ts` is the only place built-in packs are built, each from its own
directory with a `SKILL.md` beside it; `scripts/build.mjs` copies those into `dist`. A pack with
an `unavailableReason` contributes no tools, so the registry, the manifest, and MCP list only what
runs. Plugins load through `common/adapters/plugin-registry.ts` from modules that export
`createPack(options)`, recorded in `plugins.json`.

See also: [Building and testing](building-and-testing.md), [Releasing](releasing.md), and the
research records on [command matching](research/command-matching.md) and
[transport and terminal packages](research/packages.md).
