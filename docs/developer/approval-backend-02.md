# Approval backend: grant saves

What the ledger does when a lasting decision's grant cannot be written to `grants.json`, and how a
person gives that grant up. The [approval backend](approval-backend.md) page covers the port and a
decision's order. Paths are in `buckle/`.

## The ledger

`common/services/approvals/approval-registry.ts` keeps each resolved `session` or `always`
approval's grant on its entry in `approvals.json`: the id the grant is written under, its holder,
rule, subject, and scope, the source that recorded the decision, and `save`: `owed` until the grant
store holds it, then `saved`, or `skipped` once its person gave it up.

- **The settling pass:** `settleGrants` writes the workspace's owed grants under the approvals lock
  (approvals, then grants), committing each as `saved`. It runs at each decision while any grant is
  owed, on the same decision sent again, and as the workspace opens (`recover`). A failure stops the
  pass, is logged, and leaves the rest owed. It passes over `saved` and `skipped` entries.
- **Kept:** an entry whose grant is owed is never pruned. A revoke or a session end that undoes an
  owed grant drops it from its entry, under the same lock, so the pass never writes it.
- **One id:** the grant is written under the id its entry keeps, also when a pass writes it again
  after a lost commit, so a revoke by that id reaches the grant and drops its entry's mark.

## An approval left owed

The decision commits with its grant owed, then the pass runs. When the decision's own grant is
still owed after it:

- **The call that asked:** core adds a `once` for it under the same lock, bound to its session,
  actor, tool, and fingerprint, so the waiting or re-sent call clears. A repeat adds none.
- **The receipt:** `applied`, or `repeated` on a retry, with `save` and, while it is `owed`,
  `saveError`. The reason comes from `common/services/approvals/grant-save.ts`, a table keyed by the
  error's code; a node error's message names the file, so it is never used.
- **A retry:** the same decision sent again, from any source, since every decision settles every
  owed grant. It answers `repeated` with `save: 'saved'` once the grant is written.

## A skip

`skipSave(token)` on the host, and `skipSave({ source: 'cli', token })` on the core approval API,
give up the grant of a `session` or `always` approval. The skip and the settling pass each run under
the approvals lock, so one goes first:

- **Skip first:** the entry turns `skipped` and commits before anything else, so no settling pass,
  retry, or opening writes the grant. A retry then answers `repeated` with `save: 'skipped'`.
- **Settling pass first:** the grant is in the store, and the skip removes it by the id its entry
  kept; the receipt says `removed`. A grant a stopped process wrote while its entry still read
  `owed` is removed the same way.
- **Read before removing:** the skip lists the grant store and removes only a grant it finds, so a
  store that cannot be written never stops a skip of a grant it never held.
- **A removal that fails:** the entry stays `skipped` and the ledger throws `SkipUnfinishedError`,
  which the host and the core approval API answer as `unfinished`, its message naming no path.
  The grant stands until the skip is sent again, which answers `repeated` and `removed`.
- **The call that asked:** its `once` stays, so it still runs; every other call asks.
- **Who:** only the source that recorded the decision, by id and kind (`guardSkip` in
  `common/domain/approval/decision-guard.ts`). A `once` approval or a denial is refused
  `conflicting_decision`, a token with no decision `unknown_ask`, and another source
  `approver_not_allowed`. A lasting approval whose grant a revoke or a session end dropped has
  nothing left to skip, and answers `repeated`.
- **How long:** an entry left `saved` or `skipped` is pruned ten minutes after its decision, as
  other decisions are; a skip after that is refused `unknown_ask`, and `buckle grants revoke`
  removes a saved grant.
- **Audit:** each skip writes `approval_decision` entries through the log service, the attempt
  with `outcome: skip_save`, the result with `repeated` and `removed` or the refusal's `code`.

## A lasting denial

Written before its decision commits, so a denial is never recorded without being in force:

- **Superseded approvals:** the owed approvals it takes the place of are dropped and committed
  first, since one written after it would replace it in the grant store.
- **A write that fails:** the decision is refused `grant_unsaved`, `retryable: true`, with a message
  naming the scope and the reason. Nothing is recorded, and the ask waits.
- **No skip:** nothing was recorded, so refusing just the call is a `once` denial.
- **A commit that fails:** the denial is taken back. The ledger marks a decision recorded once its
  update is on disk, and a step that fails after that, such as waking the webhook sender or
  reporting an expired ask, leaves the decision applied and its denial in force.

## Routes

`common/domain/approval/grant-save-question.ts` is what every route does next. `unsavedOf` reads
a receipt: an approval with `save: 'owed'`, or a `grant_unsaved` refusal. `settleUnsaved` asks
through the route's `ask`, then sends the same decision again, skips the save, or denies the call
once, until it saves, is skipped, or is left; a retry that fails asks again, with no cap. An
`unfinished` skip asks once more, offering only a retry of the removal. Its words, keys, and
endings are one table there.

- **The terminal backend:** a `grant_save` question through the requester, by key, closed after
  `SAVE_QUESTION_WAIT_MS` (`terminal-question.ts`). An approval's waits on the backend's close
  alone, since the submit's signal aborts once the call clears; a denial's ends with its ask. The
  ending goes to `host.log`.
- **`buckle approve` and `--watch`:** the same loop over the core approval API, as `cli`. Without a
  terminal, `buckle approve` prints the warning and the commands and exits 5 (`cli/exit-codes.ts`).
- **The setup POST:** an owed approval answers `grantOwed` and `saveError`; a decision refusal
  answers 409 with its `code`, which `server/error.ts` writes beside `error`. `buckle client
  approve` warns and exits 5.

## Backends

A backend never sends a decision again, nor skips a save, on its own: after a receipt with `save:
'owed'` or a `grant_unsaved` refusal, though the refusal is retryable, its person retries, skips, or
leaves it. The contract kit in `test/support/approval-backend-kit.ts` holds these duties, and that
a retry sends the same decision once more and a skip calls `skipSave`, or denies a lasting denial
once. Its fake host records each skip. The contract stays version 1 with these fields.
