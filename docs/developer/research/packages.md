# Buckle transport and terminal packages

> Research record from 2026-09-27. It is a snapshot of upstream packages and options, not a list of Buckle's dependencies; for the current code, see [Architecture](../architecture.md).

## Overview

- [Maintenance evidence](#maintenance-evidence): upstream packages checked on 2026-09-27.
- [Encoding choice](#encoding-choice): compare bytes before selecting a protocol.
- [Interactive CLI](#interactive-cli): PTY, browser terminal, and setup prompts.

## Maintenance evidence

Versions and publication dates come from npm registry metadata; activity dates come from each upstream default branch. All listed repositories were unarchived and packages were not marked deprecated when checked.

| Package | Maintainer/project | Latest npm version | Published | Latest upstream commit |
|---|---|---|---|---|
| [flatbuffers](https://registry.npmjs.org/flatbuffers) | [Google FlatBuffers](https://github.com/google/flatbuffers) | 25.9.23 | 2025-09-24 | 2026-09-14 |
| [@msgpack/msgpack](https://registry.npmjs.org/@msgpack%2Fmsgpack) | [MessagePack project](https://github.com/msgpack/msgpack-javascript) | 3.1.3 | 2025-12-26 | 2026-07-13 |
| [@bufbuild/protobuf](https://registry.npmjs.org/@bufbuild%2Fprotobuf) | [Buf](https://github.com/bufbuild/protobuf-es) | 2.15.0 | 2026-09-11 | 2026-09-25 |
| [@connectrpc/connect](https://registry.npmjs.org/@connectrpc%2Fconnect) | [Connect project](https://github.com/connectrpc/connect-es) | 2.2.0 | 2026-09-07 | 2026-09-25 |
| [node-pty](https://registry.npmjs.org/node-pty) | [Microsoft](https://github.com/microsoft/node-pty) | 1.1.0 | 2025-12-22 | 2026-09-14 |
| [@inquirer/prompts](https://registry.npmjs.org/@inquirer%2Fprompts) | [Inquirer](https://github.com/SBoudrias/Inquirer.js) | 8.7.2 | 2026-09-07 | 2026-09-24 |

FlatBuffers and MessagePack have upstream npm implementations. Buf's Protobuf implementation is maintained by Buf; it is not Google's npm implementation. Older release dates alone do not establish abandonment.

## Encoding choice

| Candidate | Shared types | Transfer considerations |
|---|---|---|
| FlatBuffers | Language-neutral schemas, generated TypeScript | Direct field access; offsets, alignment, and table metadata can cost bytes on small messages |
| MessagePack | Application must supply schemas/contracts | Compact dynamic values; named map keys repeat unless a separate numeric/tuple contract is designed |
| Protobuf + Connect | Protobuf schema, generated messages, and RPC clients | Numbered fields; existing RPC semantics, with adapter and code-generation costs |

FlatBuffers ships the JavaScript runtime through npm and generates TypeScript with the separate `flatc` compiler. Direct access is attractive for large structured buffers. Its format uses offsets and alignment, so fastest access does not imply smallest transfer. [JavaScript support](https://flatbuffers.dev/languages/javascript/), [format internals](https://flatbuffers.dev/internals/)

MessagePack is a serialization format, not a complete RPC protocol or shared type-definition system. A custom endpoint still needs methods, schema/version negotiation, validation, errors, cancellation, and streaming. [Upstream JavaScript implementation](https://github.com/msgpack/msgpack-javascript)

Recommendation remains provisional: benchmark Protobuf/Connect, FlatBuffers, and MessagePack against identical Buckle payloads. Include compressed/uncompressed bytes, complete HTTP overhead, cold/warm connections, encryption/signatures, CPU, and package size.

Cloudflare compatibility depends on HTTP/WS transport and deployment settings, not the binary encoding. Preserve MCP adapters for ecosystem compatibility.

## Interactive CLI

- `node-pty`: actual interactive child processes, REPLs, input/output, and terminal resize. Buckle already has a PTY adapter; validate native installation on supported Linux architectures. [Upstream API](https://github.com/microsoft/node-pty)
- `@xterm/xterm`: browser terminal rendering. It needs the remote PTY service and authenticated transport. [xterm.js](https://github.com/xtermjs/xterm.js)
- `@inquirer/prompts`: owner-facing setup selections, confirmations, and password prompts. It does not turn arbitrary subprocesses into shared terminals. [Inquirer prompts](https://github.com/SBoudrias/Inquirer.js)

Use the existing PTY adapter and consider Inquirer for init. Common services must supply controller handoff, approval routing, output fan-out, censoring, and audit. No listed package supplies that entire security contract. Preserve shared output and hidden human password input.
