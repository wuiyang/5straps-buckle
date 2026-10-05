# @5straps/runtime

The runtime primitives Buckle is built on: service lifetimes, async scopes, lifecycle, CLI
interaction, logging with credential redaction, SQLite ownership on `node:sqlite`, and Nitro
adapters.

## Who uses it

`@5straps/buckle`, in this repository, is its consumer. Buckle's CLI and its built Nitro server
load one shared copy, so both see the same scopes and services.

## Entry points

| Import | What it holds |
|---|---|
| `@5straps/runtime` | Services, scopes, lifecycle, interaction, logging, transaction guards, and errors |
| `@5straps/runtime/sqlite` | SQLite databases, connection ownership, busy handling, and locks on `node:sqlite` |
| `@5straps/runtime/nitro` | Adapters that run the services inside a Nitro app |

Node.js 24 or newer. It depends on db0 0.4.1; nitro 3.0.260903-beta and h3 2.0.1-rc.32 are
optional peers, needed only for `@5straps/runtime/nitro`.

## License

Apache-2.0. Copyright 2026 The 5straps Authors. See [LICENSE](https://github.com/wuiyang/5straps-buckle/blob/main/LICENSE)
and [NOTICE](https://github.com/wuiyang/5straps-buckle/blob/main/NOTICE).
