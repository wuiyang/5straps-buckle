---
name: buckle-dev
description: Navigate and refactor code on a 5straps Buckle node using a language server, covering definitions, references, hover types, diagnostics, and rename. Use to locate code precisely instead of grepping.
---

# Buckle dev

Language-server queries. Far more precise than text search: `lsp_references` finds actual
references, not every string that happens to match a name.

```
buckle dev definition src/app.ts --language typescript --line 42 --character 8
buckle dev references src/app.ts --language typescript --line 42
buckle dev hover src/app.ts --language typescript --line 42
buckle dev diagnostics src/app.ts --language typescript
buckle dev rename src/app.ts --language typescript --line 42 --new-name createInvoker
```

Lines are 1-based on the way in and converted to the LSP's 0-based positions for you.

## Attaching to a running server

`lsp_discover` lists language servers already running on the machine. It asks for approval
first, because listing processes exposes other people's command lines.

Each result is classified:

- `socket` means the server was started in TCP mode and can be attached to. Pass its `port` as
  `attachPort` to reuse it, keeping its warm index.
- `spawn_twin` means the server communicates over stdio owned by the editor that launched it.
  Nothing can attach to those pipes. Buckle instead starts its own instance of the same
  binary against the same project.

A freshly spawned server needs time to index a large project before its answers are complete.

## Rename returns edits, it does not apply them

`lsp_rename` gives you a workspace edit to inspect. Apply it with `fs_patch`, which goes
through the normal write approval.
