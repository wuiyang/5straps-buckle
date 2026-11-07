# Approval backend

How an ask reaches a person and how their decision comes back. Core decides everything; a
backend carries asks out and decisions in, and enforces nothing. Paths are inside `buckle/`.

## The port

`common/types/ports/approval-backend.ts` is contract version 1.

- **`ApprovalBackend`:** core calls `open(host)`, which answers with the backend's
  capabilities, then `submit(asks, context)` for one call's asks, `notify(events)` when an ask
  leaves the queue, and `close()`. A submit answers `accepted` or `declined`, never a decision.
- **`ApprovalHost`:** what core hands a backend at open. `decide` is the one way a decision
  enters; `pending` and `ask` give the asks routed to the backend, each a `FullAsk`; `log`
  writes to the node's log. `host.source` is bound by core, so a backend never names its own.
- **`FullAsk`:** the whole ask, never cut (D9, D17): token, group, an idempotency key that is
  an HMAC under a per-process secret, the requester, the rule's subject and offered scopes, the
  decision AI's notes, the deadline, and the call. An ask whose whole call was not kept carries
  no `action` and can only be denied.
- **Receipts:** `applied` with the assurance core rated, `repeated`, or `refused` with an
  `ApprovalErrorCode`. A failure, a timeout, or a refusal is no decision.

## The module boundary

**Core keeps:** the permission engine and the floor and destructive marks its rules set, the
dangerously-allow switch, the decision AI, the approval gate (`common/services/approvals/approval-gate.ts`),
the ask ledger (`approval-registry.ts`) and the `once` store (`once-store.ts`), the decision
guard (`common/domain/approval/decision-guard.ts`), source rights (`assurance.ts`), recorded
routes (`routes.ts`), the grant store, and the core approval API (`core-approval-api.ts`).

**Core clients, not backends:** `buckle approve`, `buckle approvals --watch`,
`--approve-if-safe`, and the setup routes. Each calls `decide` with a source tag (`cli`,
`judge`, `devices`, or `sealed`), and core holds the source that tag names. A receipt for a core
client also says which step refused it: the proof (401 on the setup POST), the statement (400),
or the decision (409).

`test/approval-boundary.test.ts` holds the boundary: only the approval service records a
verdict, only the gate spends a `once`, only the ledger runs the guard, the faces reach the
service through the core API alone, and no backend imports an approval service or the ledger's
schema.

## A decision, in order

1. The decision audit hears it received (`common/types/ports/decision-audit.ts`).
2. The guard screens it before the ledger lock: the source's kind may approve, a lasting scope
   needs `local` or above, and a host pattern comes from `cli` alone.
3. Under the lock it checks, in order: a repeat of the decision applied, the ask is waiting,
   the source was routed this ask, the challenge a device signed is the ask's, the call was kept
   whole, a floor ask's approval comes from a person at `local` or above, scope `always` on a
   destructive ask where the floor policy forbids it, the scope offered, a wider subject from the
   terminal or `cli` alone, sensitive files, a signed `once` inside its proof's deadline, and the
   host pattern covers the host that asked.
4. The resolved entry commits, then its grant is written; a grant left owed is written when
   the workspace next opens.
5. The audit hears it applied or refused, outside the lock.

## Sources and their rights

| Source | Assurance | Approves |
|---|---|---|
| `terminal`, `cli` | `local` | Any ask, and the wider subject; `cli` alone takes a host pattern |
| `forms` | `local` | Any ask, lasting scopes and floor asks included |
| `devices` | `key` | Any ask it signed the challenge of |
| `judge` | `relayed` | A non-floor `once`, bound to the code it rated |
| `sealed` (kind `backend`) | `relayed` | Nothing; it denies, a sensitive file's lasting denial included |

Rights follow the kind core holds, never the id: a source named `terminal` of kind `backend`
gets a backend's. `cli` and `judge` count as routed to every ask.

## What the built-in backends own

**The terminal** (`common/adapters/approval/terminal-backend.ts`): the serve terminal and the
one-shot prompt. It asks each submitted ask in turn over the operation's requester, opens one
request per call key and group, drops a question whose ask left the queue, and decides through
`host.decide`. `terminal-question.ts` and `ask-view.ts` put the ask into words.

**The forms** (`mcp/forms-backend.ts`): a stdio MCP host's elicitation. It is pulled, not
pushed: the MCP face draws one form per ask in the answer to the call that asked, and decides
each answer the retried call carries. Its `submit` declines. It never sends an approval of an
ask whose whole call was not kept. The stdio face opens it with `openFormsBackend`; the HTTP
face has none, so nothing the agent's token reaches answers an ask.

Neither rates an answer, picks a scope, writes a grant, or audits. Both run in the process
whose terminal or MCP host they speak to.

## Seams held at today's answers

- **Owner question 1:** `alwaysAtFloor` in `common/domain/permission/floor-policy.ts`. The file
  floor offers `always`, and the guard lets a destructive ask take it where offered. An `always`
  grant held earlier still clears a file-floor ask, since the grant lookup carries no scope.
- **Owner question 3:** the `forms` entry in `assurance.ts`. At `relayed`, the guard would hold
  form answers to a non-floor `once`.
- **Owner question 4:** `switchLiftsFloor` in the same floor policy. The switch lifts floor
  asks.
- **Owner question 5:** the decision audit runs on every answer, but the runtime plugs in
  `NO_DECISION_AUDIT`, which writes nothing, and `blockOnAuditFailure` is off.

## What remote backends will need

- **Routes:** a routing policy in node config, and each ask recording its routes in the ledger.
  Today every ask reads as sent down today's set (`TODAYS_ROUTES`): the terminal, forms, and
  devices decide, and the sealed envelope only denies.
- **Signed decisions:** the signed `DecisionInput`, proof verifiers, a nonce claim per
  statement, a `decisionId` kept with the resolved entry, approvers derived from the proof, and
  a `moot` receipt for an ask already closed.
- **Delivery:** serve alone holding remote connections under a lease, a durable submit queue,
  each ask's backend refs in the ledger, and `renewed` events carrying a new expiry.
- **Grants:** `host.grants` to list and revoke the grants a source issued, and an expiry on
  every lasting grant a remote source makes.
- **Egress:** an `AskSummary` for a route that only notifies.
- **Startup:** refusing any configured source that names a built-in one, `sealed` included.

A pushed backend runs the contract kit in `test/support/approval-backend-kit.ts` against a fake
host, as the terminal does in `test/terminal-backend.test.ts`. The forms, being pulled, have
their own suite in `test/forms-backend.test.ts`.
