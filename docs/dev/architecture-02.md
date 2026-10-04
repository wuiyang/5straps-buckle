# Architecture: state and packs

The second part of the map of Buckle, the approval and sandbox runtime that lets an AI agent work
on one machine: where approvals live on disk, and how packs bring tools.
[Architecture](architecture.md) covers the packages, the layers, the path of a tool call, and the
pieces that decide it. Paths are inside `buckle/` unless they start with `packages/`.

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

See also: [Building and testing](building-and-testing.md) and [Releasing](releasing.md).
