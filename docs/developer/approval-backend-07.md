# Approval backend: face sessions

The sessions each face holds and when they end, the idle window's settings, and the tests. [Session
activity](approval-backend-06.md) covers activity, the idle check, and what an end removes. Paths
are in `buckle/`.

## Face sessions

`FaceSession` (`common/services/workspaces/face-session.ts`) is the session a process's own face
holds in each workspace it opens. `initializeCommon` picks it by role (`FACE_SESSIONS` in
`common/runtime/initialize.ts`), exposes it as `BuckleCommon.faceSession`, and hands it through
the workspace manager to `createRuntime`:

- **`server`:** `SERVE_SESSION`, `mcp` (`HTTP_MCP_SESSION`), which `mcp/http.ts` names every call
  by, as `/mcp` is served stateless. Ended at each open, `serve_started`, once the approval
  service is built and before any call is served, so what a serve killed before its close left
  clears nothing; an end that throws fails the open, which the next resolve tries again. Ended at
  close, `serve_stopped`.
- **`mcp`:** `stdioSession()`, `stdio:<uuid>`, minted per process, which `serveMcpStdio` passes to
  `createStdioServer`. Ended at close, `stdio_closed`.
- **`cli`:** none; `cli` ends at idle alone.

The close end is the runtime's `endFaceSession()`, which `closeWithOwner`
(`common/runtime/services.ts`) runs for every open runtime at once at the `timers` stage, before
the `waiters` stage settles the other waits, so held callers hear their asks withdrawn. A runtime
dropped while the process runs ends none; serve's next open does. `McpServerOptions.sessionId` is
required, as neither transport names a session.

## Settings

`approval.sessionIdleMs` in `workspace.json`, else `BUCKLE_APPROVAL_SESSION_IDLE_MS` (alias
`approval-session-idle`), else 900000 (`DEFAULT_SESSION_IDLE_MS`). `parseSessionIdle` takes 0 or
60000 to 86400000 (`SESSION_IDLE_BOUNDS`). The runtime reads it from `config` as taken up: a
workspace's value at its next call, the node's as the process starts, so each process ends sessions
at its own window until it restarts.

## Tests

- **`test/executing-mark.test.ts`:** the mark, a first write that fails, and the hold through the
  checkpoint after the tool.
- **`test/face-sessions.test.ts`:** a stdio process's own id on each call, two stdio processes each
  ending its own alone, the CLI ending none, and serve ending `mcp` at its start after a crash, on
  a workspace brought back online, and at its stop; an end at open that fails fails the open.
- **`test/session-idle.test.ts`:** the verdict, the setting at each layer, and the store (a call
  end on a later turn, a busy read); the end through the service: every face's grants, onces,
  owed marks, withdrawn asks and their webhook notices and ledger reason, the record, a tool that
  starts between the first read and the lock, a second process's long tool, activity seen after a
  gap, and unknown or busy activity.
- **`test/session-idle-runtime.test.ts`:** a faked clock through a runtime: a CLI call after idle,
  a late decision from another process, the sweep, a held ask, a dropped result, a decision read
  by another process, what is not activity, the grant fallback, window 0, and an unreadable store
  in one process and in a second.
- **`test/approval-ledger-split.test.ts`:** a session ended while `approvals.json` was unreadable,
  whose asks and onces go once it is repaired.
