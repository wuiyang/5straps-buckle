# Approval backend: an ask nobody answers

An ask nobody answers before it runs out, at its stated expiry or its lapse, is skipped with the
reason `no_response`, never denied (APPROVAL-36, owner 2026-11-10). When it runs out is the
ledger's, as before; [the executing mark](approval-backend-09.md) covers the lapse and what holds
it. [The user page](../user/how-to/approvals-09.md) says what each route shows. Paths are in
`buckle/`.

## The ledger

- **The drop:** every `update` in `common/services/approvals/approval-registry.ts` prunes first,
  as before. Each ask `prune` drops goes onto the file's `noResponse` list, `{ workspace, token,
  expiresAt }`, kept ten minutes (`PENDING_TTL_MS`) as the `ended` list keeps a session end, and
  its webhook end is queued in the same update. `common/domain/approval/ledger-state.ts` holds
  the list's schema.
- **How it left:** `departures` reads this process's own departures, then `ended`, `noResponse`,
  and `resolved`. A dropped ask reads `NO_RESPONSE`, `{ type: 'skipped', reason: 'no_response' }`,
  in every process. One no process kept reads the same past its stated expiry, and `cancelled`
  otherwise (`departureOf` in `approval-service.ts`).
- **A late answer:** `applyDecision` hands the guard `closed: 'no_response'` for a token on the
  list, and the guard refuses it `ask_closed`. Past the ten minutes the token is `unknown_ask`,
  "unknown or no longer waiting".
- **The report:** once the update is on disk, `onNoResponse` gets this workspace's dropped asks,
  each with its request and the attempt entry of the call that raised it. `assembleRuntime` tells
  the notices, writes one `approval_skipped` entry per ask through `DecisionAudit.noResponse`, and
  logs `Skipped approvals nobody answered before they ran out` with the count. The action log
  opens before the ledger, so an ask the first update drops is recorded too.

## The webhook

`approval-notices.ts` sends `{ event: 'skipped', reason: 'no_response' }`. The durable outbox
keeps the end as `{ event: 'expired' }`, the shape a build from before this ruling reads, so a
rollback, or a serve still running beside a newer command, still reads `approvals.json`.
`pendingDeliveries` reads it through `sentNotice` as the skipped notice, an entry an older node
queued included. `endsAsk` in the registry tells an end from a wait notice: an end replaces a
wait notice queued for its token, and a wait notice never replaces an end.
`enqueueSkippedNotices`, the routes' one way in, refuses a `no_response` notice as it refuses any
end, and `WaitSkipReason` types the reasons a wait notice takes.

This change breaks a receiver on an older `@5straps/protocol`: it refuses the new reason and
answers the whole post HTTP 400. `createApprovalNoticeSender` throws `NoticeRefusedError` for
400, 413, and 422; any other failure stays a plain error. On that error the queue sends the batch
in halves until the refused notice is alone, then acknowledges what was taken and drops the
notice refused on its own, with one warning, later drops at debug. Kept, it would be refused at
every retry and hold the room new asks need. An outage or a 401, 403, 404, 429, or 5xx never
splits a batch.

## The port

`EventType` loses `expired`: a backend's `notify` hears `skipped` with `reason: 'no_response'`.
`EventReason` is a `CancelReason` (`caller_cancelled`, `evicted`, `withdrawn_by_owner`, or
`session_ended`) or `no_response`; a grant-save skip names none. The `AskState` `expired` is now
`skipped`.

## The call

`finish` in `approval-service.ts` settles as before. Past a recheck that does not clear and no
earlier run, the invoker (`common/services/invocation/invoker.ts`) asks the gate's
`unanswered(approvals)`. A token there answers `APPROVAL_SKIPPED`, `retryable`, with `details:
{ reason: 'no_response' }`; otherwise the call answers `APPROVAL_UNANSWERED`, for an ask withdrawn
or a `once` spent. The read is lazy, so an approved call reads nothing more.

## The routes

- **The serve terminal:** `ending` in `cli/terminal-consumer.ts` says `[skipped: no response]`
  where the clock has passed `expiresAt`, within `TIMER_JITTER_MS`, or where the terminal backend
  told it so. The requester aborts the consumer's signal with no reason, so a lapse before the
  stated expiry goes another way: on a `skipped` event with `no_response`, the backend's `notify`
  calls `tellQuestionEnding` with the question's id before it closes the question, and the
  consumer reads it once through `takeQuestionEnding` (`common/adapters/approval/question-endings.ts`,
  process-wide, the latest 256 kept).
- **`--watch`:** `ranOut` in `cli/approvals-watch.ts` reads the clock, then
  `CoreApprovalApi.departure`, so a lapse reads as skipped too.
- **A deadline line:** `describeExpiry` and `describeLocalExpiry` say `skipped: no response
  (<time>)` once it has passed (`NO_RESPONSE_LINE`).

## Tests

- `test/approval-no-response.test.ts`: every process reads the end, a late answer from any
  process is told, the webhook end replaces a wait notice and is never replaced, no route queues
  one, the outbox keeps the end in the shape an older build reads, an older node's `expired` entry
  is sent as skipped, and the deadline and log lines.
- `test/approval-join.test.ts`: a held call answers `APPROVAL_SKIPPED`, and the audit entry lands.
- `test/approval-terminal-port.test.ts`, `test/approvals-watch.test.ts`,
  `test/approval-terminal.test.ts`, `test/approval-notices.test.ts`, and
  `test/approval-outbox.test.ts`: each route's words and events, another process's drop and a
  lapse before the stated expiry included, and a receiver on the older protocol.
