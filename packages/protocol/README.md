# @5straps/protocol

The versioned wire schemas, written with zod, that Buckle speaks: tool manifests, invocations,
approvals, policy, workbenches, signed requests, and sealed envelopes. The package also holds the
schemas the Rings control plane and its clients share with each other (sessions, runs,
projects, streams, chat tools, preferences, and node bindings).

## Who uses it

- `@5straps/buckle`, in this repository, validates every request and response with it.
- The Rings control plane and its clients install it from npm to talk to Buckle nodes.

## Entry points

| Import | What it holds |
|---|---|
| `@5straps/protocol` | Every schema and its TypeScript type |
| `@5straps/protocol/envelope` | Sealed envelopes for approval traffic between a Buckle node and the Rings control plane it is paired with |
| `@5straps/protocol/signed-request` | Requests signed with a client's Ed25519 key, which prove who calls Buckle's setup and approval routes |

Node.js 24 or newer. Its one dependency is zod.

## License

Apache-2.0. Copyright 2026 The 5straps Authors. See [LICENSE](https://github.com/wuiyang/buckle/blob/main/LICENSE)
and [NOTICE](https://github.com/wuiyang/buckle/blob/main/NOTICE).
