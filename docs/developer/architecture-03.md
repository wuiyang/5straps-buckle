# Architecture: code mode

The third part of [Architecture](architecture.md), after [state and packs](architecture-02.md).
Paths are inside `buckle/`.

## Code mode

Code mode ([user guide](../user/how-to/code-mode.md)) runs an agent's script that calls the other
tools. Four pieces:

- **The port:** `common/types/ports/script-vm.ts`, what Buckle needs from a script VM. A run takes
  the script, the tools it may call, limits (deadline, memory, output), a clock start, a seed, and
  `onCall`; the host answers each call with `deliver(seq, now, id, outcome)`, and the run yields
  output items, the return value, the calls made, and an error kind (`script`, `timeout`,
  `aborted`, `sandbox`). The run reports `onIdle` once it has applied every result it was handed,
  after the calls that turn made, so a host stops it at an ask without losing a call. The port also
  renders the declarations a script reads.
- **The adapter:** `common/adapters/script-vm/pi-codemode.ts`, the only module that imports
  `@earendil-works/pi-codemode`. It runs QuickJS, compiled to WebAssembly by `quickjs-wasi`, in a
  worker thread per script through `CodemodeSandbox.start()`, the deterministic run. It finds the
  worker file and the wasm where the package is installed, so a bundled server finds them too,
  gives each VM 256 MiB, and holds at most four live VMs per process, two of them per workspace.
- **The pack:** `common/services/packs/code/`, with `code_run` and `code_api`. The pack never reaches
  the registry: `ToolDefinition.reachesTools` makes the invoker hand it `invokeNested`, and the
  invoker builds each nested request itself, with the outer call's session, actor, approval tokens,
  wait, signal, and context, its stage unchanged so a script reaches the caller's browser sessions,
  the outer requestId as the audited `parentRequestId`, and a requestId of `code:<key>:<call number>`. A nested call goes through the workspace runtime's invoker, under the
  settings its script started with, so it is judged, audited, counted, and cancelled at shutdown like any other. Its approval wait ends
  a second before the script's deadline. Buckle's own aborts leave its asks pending; the outer
  caller's own cancel withdraws them, and so do `CODE_REPLAY_TOO_LARGE` and `CODE_REPLAY_DIVERGED`.
  A call that asks makes the pack throw `NestedApprovalRequired`, which the invoker answers as
  `approval_required`. The invoker tells the pack when a nested call's tool begins to run, and
  only the outer caller's own cancel reports as one. The re-send dedupe keeps a nested call that
  ran as a stub without its body, in a bound of its own, since the journal replays its result.
- **The journal:** `common/services/packs/code/journal.ts`, one file per script that stopped
  before its own end (an ask, its deadline, a cancel, a shutdown, or its sandbox),
  `<state>/code-journal/<workspace key>/<key>.json`, holding the clock start, the seed, the tools,
  the first run's requestId, the script, the tokens of its asks, and every tool call's result, in
  order, with each tool's input schema; `describeTool` and `searchTools` are answered from that list,
  and only their numbers and arguments' fingerprints are recorded, as are those of each tool call
  that got no result;
  a call a stop cut after its tool began to run is recorded as run, its effects unknown. Past
  32 MiB of results, every call is kept as a stub that says it ran, without its result, so the
  script cannot resume but no call of it runs again; a record whose replay handed out such a stub
  stays until it expires, however the script ends. It is
  written when the script stops, so a crash mid-script loses what ran since the last stop.
  The key hashes the session, the actor, and the script's text, so `timeoutMs` may change. A
  re-sent script is answered from it call for call, and a call whose tool or arguments differ
  refuses the run. The store prunes expired journals and crashed writes when it opens and at each
  write; `buckle approvals show` reads a script back by its ask's token.

The adapter is temporary. The owner plans a VM written for Buckle, which implements the port; the
pack, the invoker, and the journal stay as they are, and a journal from the old VM is refused by
its recorded VM fingerprint rather than replayed on the new one.

See also: [Building and testing](building-and-testing.md) and [Releasing](releasing.md).
