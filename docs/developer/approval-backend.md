# Approval backend

How an ask reaches a person and their decision comes back. Core decides; a backend carries
asks out and decisions in, and enforces nothing. Paths are inside `buckle/`.

## The port

`common/types/ports/approval-backend.ts` is contract version 1.

- **`ApprovalBackend`:** core calls `open(host)`, which answers with the backend's
  capabilities, then `submit(asks, context)` for one call's asks, `notify(events)` when an ask
  leaves the queue, and `close()`. A submit is `accepted` or `declined`, never a decision.
- **`ApprovalHost`:** handed over at open. `decide` is the one way a decision enters;
  `pending` and `ask` give the asks routed to the backend; `log` writes to the node's log. Core
  binds `host.source`, so a backend never names its own.
- **`FullAsk`:** the whole ask, never cut, as an approver sees the full raw action: token,
  group, an HMAC idempotency key, the requester, the rule's subject and offered scopes, the
  decision AI's notes, the deadline, and the call. Without a kept call it has no `action` and
  can only be denied.
- **Receipts:** `applied` with the assurance core rated, `repeated`, or `refused` with an
  `ApprovalErrorCode`. A failure is no decision.

## The module boundary

**Core keeps:** the permission engine and its floor and destructive marks, the
dangerously-allow switch, the decision AI, and, in `common/services/approvals/`, the gate, the
ask ledger, the `once` store, and the core approval API. The guard, source rights, and routes
are in `common/domain/approval/`.

**Core clients, not backends:** `buckle approve`, `buckle approvals --watch`,
`--approve-if-safe`, and the setup routes. Each holds `runtime.approvalApi`, typed as the core
approval API, and calls `decide` with a source tag (`cli`, `judge`, `devices`, or `sealed`);
core holds the source that tag names. A `devices` input carries the `DeviceProof` the request
verifier minted once the signature checked and its nonce was claimed; core refuses any other.
A refusal names its step: proof (401 on the setup POST), statement (400), or decision (409).

`test/approval-boundary.test.ts` holds it: only the service records a verdict, the gate
spends a `once`, the ledger runs the guard, the verifier mints a proof, and the stdio face
opens forms; no face names the service itself, and no backend reaches the permission engine,
the guard, the ledger's schema, or a service.

## A decision, in order

1. Core reads the input: a device's proof, or a sealed envelope opened and its nonce claimed,
   then the body as the statement. A refusal here never reaches the audit.
2. The decision audit hears it received.
3. The guard screens it before the ledger lock: the source's kind may approve, a lasting scope
   needs `local` or above, and a host pattern comes from `cli` alone.
4. Under the lock, in order: a repeat, the ask waiting, the source routed, a device's
   challenge matching, the call kept whole, a floor approval from a person at `local` or
   above, the scope offered, no `always` on a destructive command or where the floor policy
   forbids it, a wider subject from the terminal or `cli` alone, sensitive files, lasting
   denials for sensitive files alone, a signed `once` inside its deadline, and the host pattern
   covering the host that asked.
5. The resolved entry commits, then its grant; a grant left owed is written on next open.
6. The audit hears it applied or refused, outside the lock.

## Sources and their rights

| Source | Assurance | Approves |
|---|---|---|
| `terminal`, `cli` | `local` | Any ask, and the wider subject; `cli` alone takes a host pattern |
| `forms` | `local` | Any ask, lasting scopes and floor asks included |
| `devices` | `key` | Any ask it signed the challenge of |
| `judge` | `relayed` | A non-floor `once`, bound to the code it rated |
| `sealed` | `relayed` | Nothing; it denies, a sensitive file's lasting denial included |
| A configured backend | `relayed` | Nothing; it denies for one call |

Rights follow the kind, never the id: a backend named `terminal` or `sealed` gets a backend's
rights and no route. `cli` and `judge` count as routed to every ask.

## What the built-in backends own

**The terminal** (`common/adapters/approval/terminal-backend.ts`): the serve terminal and the
one-shot prompt. It asks each ask in turn, one request per call key and group, and drops a
question whose ask left the queue.

**The forms** (`mcp/forms-backend.ts`): a stdio MCP host's elicitation, pulled, not pushed.
The MCP face draws one form per ask in the answer to the call that asked, and decides each
answer the retried call carries; `submit` declines. The stdio face opens it through
`openForms`; the HTTP face has none, so nothing the agent's token reaches answers an ask.

Each maps a person's answer to a decision and its scope, and decides through `host.decide`.
Neither decides which scopes are allowed, rates an answer, writes a grant, or audits.

## Switches kept at today's behavior

- **The file floor and `always`:** `alwaysAtFloor` in `common/domain/permission/floor-policy.ts`
  is on: the file floor offers and takes `always`, and an earlier `always` grant on a floor
  subject or a `delete-below` folder clears its ask. Off, it offers once and the session, the
  guard refuses `always`, and the floor reads no `always` grant. A destructive command never
  takes `always`.
- **Form answers:** the `forms` entry in `assurance.ts` counts them as a person's. Rated
  `relayed`, the guard would hold them to a non-floor `once`, and the forms would also need to
  offer `once` alone and name `buckle approve <token> --scope session`, which they do not yet.
- **The dangerously-allow switch:** `switchLiftsFloor` in the same policy is on: it lifts
  floor asks.
- **Decision audit:** it runs on every answer, but the runtime plugs in `NO_DECISION_AUDIT`,
  which writes nothing; `blockOnAuditFailure` is off.

## What remote backends will need

- **Routes:** a routing policy in node config, and each ask recording its routes. Today every
  ask reads as sent down `TODAYS_ROUTES`: the terminal, forms, and devices decide, and the
  sealed envelope only denies.
- **Signed decisions:** the signed `DecisionInput`, proof verifiers, a nonce claim per
  statement, a kept `decisionId`, approvers derived from the proof, and a `moot` receipt.
- **Delivery:** serve alone holding remote connections under a lease, a durable submit queue,
  backend refs in the ledger, and `renewed` events.
- **Grants:** `host.grants` to list and revoke a source's grants, and an expiry on every lasting
  grant a remote source makes.
- **Egress:** an `AskSummary` for a notify route.
- **Startup:** refusing a configured source that names a built-in id, which the guard already
  routes nothing.

A pushed backend runs the contract kit in `test/support/approval-backend-kit.ts`, as the
terminal does; the pulled forms have their own suite, `test/forms-backend.test.ts`.
