# Approval backend: grant saves

What the ledger does when a lasting decision's grant cannot be written to `grants.json`. The
[approval backend](approval-backend.md) page covers the port and a decision's order. Paths are in
`buckle/`.

## The ledger

`common/services/approvals/approval-registry.ts` keeps each resolved `session` or `always`
approval's grant on its entry in `approvals.json`: the id the grant is written under, its holder,
rule, subject, and scope, and `save`, `owed` until the grant store holds it, then `saved`.

- **The settling pass:** `settleGrants` writes the workspace's owed grants under the approvals lock
  (approvals, then grants), committing each as `saved`. It runs at each decision while any grant is
  owed, on the same decision sent again, and as the workspace opens (`recover`). A failure stops the
  pass, is logged, and leaves the rest owed.
- **Kept:** an entry whose grant is owed is never pruned. A revoke or a session end that undoes an
  owed grant drops it from its entry, under the same lock, so the pass never writes it.
- **One id:** the grant is written under the id its entry keeps, also when a pass writes it again
  after a lost commit, so a revoke by that id reaches the grant and drops its entry's mark.

## An approval left owed

The decision commits with its grant owed, then the pass runs. When the decision's own grant is
still owed after it:

- **The call that asked:** core adds a `once` for it under the same lock, bound to its session,
  actor, tool, and fingerprint, so the waiting or re-sent call clears. A repeat adds none.
- **The receipt:** `applied`, or `repeated` on a retry, with `grantOwed` and `saveError`. The
  reason comes from `common/services/approvals/grant-save.ts`, a table keyed by the error's code;
  a node error's message names the file, so it is never used.
- **A retry:** the same decision sent again. It answers `repeated` without `grantOwed` once the
  grant is written.

## A lasting denial

Written before its decision commits, so a denial is never recorded without being in force:

- **Superseded approvals:** the owed approvals it takes the place of are dropped and committed
  first, since one written after it would replace it in the grant store.
- **A write that fails:** the decision is refused `grant_unsaved`, `retryable: true`, with a message
  naming the scope and the reason. Nothing is recorded, and the ask waits.
- **A commit that fails:** the denial is taken back. The ledger marks a decision recorded once its
  update is on disk, and a step that fails after that, such as waking the webhook sender or
  reporting an expired ask, leaves the decision applied and its denial in force.

## Backends

A backend never sends a decision again on its own after a receipt with `grantOwed` or a
`grant_unsaved` refusal, though the refusal is retryable: its person retries or leaves it. The
contract kit in `test/support/approval-backend-kit.ts` holds both duties. The contract stays version
1 with these fields.
