# Approval backend

How an ask reaches a person and their decision comes back. Core decides; a backend carries
asks out and decisions in, and enforces nothing. Paths are in `buckle/`.

## The port

`common/types/ports/approval-backend.ts` is contract version 1.

- **`ApprovalBackend`:** core calls `open(host)`, which answers with the backend's
  capabilities, then `submit(asks, context)` for one call's asks, `notify(events)` when an ask
  leaves the queue (`session_ended` where [its session ended](approval-backend-07.md), `no_response`
  where [nobody answered](approval-backend-10.md)), and `close()`. A submit is `accepted` or
  `declined`, never a decision.
- **`ApprovalHost`:** handed over at open. `decide` is the one way a decision enters,
  `skipSave` gives up an approval's grant; `pending` and `ask` give the asks routed to the
  backend; `log` writes the node's log. Core binds `host.source` and `host.reach`, whose asks
  that source may answer; a backend names neither.
- **`FullAsk`:** the whole ask, never cut, as an approver sees the full raw action: token,
  group, an HMAC idempotency key, the requester, the rule's subject, offered scopes, the
  decision AI's notes, the deadline, and the call. Without a kept call it has no `action`.
- **Receipts:** `applied` with the assurance core rated, `repeated`, or `refused` with an
  `ApprovalErrorCode`; one for a lasting approval names its grant's `save` state, and a pathless
  `saveError` while unsettled. Core checks each decision's shape first. A failure is no decision.

## The module boundary

**Core keeps:** the permission engine and its floor and destructive marks, the
dangerously-allow switch, the decision AI, and, in `common/services/approvals/`, the gate, the
ask ledger, the `once` store, and the core approval API. The guard, source rights, and routes
are in `common/domain/approval/`.

**Core clients, not backends:** `buckle approve`, `buckle approvals --watch`,
`--approve-if-safe`, and the setup routes. Each holds `runtime.approvalApi` and calls `decide` with a source tag (`cli`, `judge`, `devices`, or `sealed`); core holds
the source that tag names. Faces get a runtime type without the ledger or service;
`CoreRuntime` adds them. A `devices` input carries the `DeviceProof` the request verifier
minted for the body it checked; core spends it on one decision. A refusal names its step:
proof (401 on the setup POST), statement (400), or decision (409).

`test/approval-boundary.test.ts` holds it: only the service records a verdict, the gate
spends a `once`, the ledger runs the guard, the verifier mints a proof, and only the MCP faces
import the forms opener, which no runtime type carries; no face names the service or
`CoreRuntime`, and no backend module reaches the permission engine, the guard, the ledger's
schema, a service, or the node's logger.

## A decision, in order

1. Core reads the input: a device's proof, or a sealed envelope opened and its nonce claimed,
   then the body as the statement. A refusal here skips the decision audit.
2. The decision audit hears it received, with its proof kind.
3. The guard screens it before the lock: a form answer only while [forms are
   on](approval-backend-04.md), the source's kind may approve, a lasting scope needs `local` or
   above, and a host pattern comes from `cli` alone.
4. Under the lock, in order: that screen again, [the caller](approval-backend-04.md#the-caller),
   a repeat, the ask waiting, the source routed, a device's challenge matching, the call kept
   whole, a floor approval from a person at `local` or above, the scope offered, no `always` on
   a destructive command or where the floor policy forbids it, a wider subject from a person
   ([any route](approval-backend-11.md)), sensitive files, lasting denials for sensitive files alone, a signed `once`
   inside its deadline, and the host pattern covering the host that asked.
5. An approval commits, then its grant; a lasting denial is written first, and withdrawn if its
   decision cannot commit. [Grant saves](approval-backend-02.md) covers a write that fails.
6. The audit hears it applied, refused, or failed, outside the lock. `logged-decision-audit.ts`
   writes each as `approval_decision`, naming who answered, the widening, and the call's attempt
   entry, through the log service, never blocking.

## Sources and their rights

| Source | Assurance | Approves |
|---|---|---|
| `terminal`, `cli` | `local` | Any ask; `cli` alone takes a host pattern |
| `forms` | `local` | Any ask, lasting and floor included, while forms are on |
| `http-forms` | `local` | As `forms`, for the asks its own caller raised |
| `devices` | `key` | Any ask it signed the challenge of |
| `judge` | `relayed` | A non-floor `once`, bound to the code it rated |
| `sealed` | `relayed` | Nothing; it denies, a sensitive file's lasting denial included |
| A configured backend | `relayed` | Nothing; it denies for one call |

Rights follow the kind, never the id: a backend named `terminal` gets a backend's rights and no
route. `cli` and `judge` count as routed to every ask.

## What the built-in backends own

**The terminal** (`common/adapters/approval/terminal-backend.ts`): the serve terminal and the
one-shot prompt. It asks each ask in turn, one request per call key and group, and drops a
question whose ask left the queue.

**The forms** (`mcp/forms-backend.ts`): an MCP host's elicitation, pulled, opened by both faces
([over HTTP](approval-backend-05.md)). Each draws one form per ask in the call's answer, offering
what the ask offers, and decides each answer the retried call carries; `submit` declines.

Each maps a person's answer to a decision and scope, and decides through `host.decide`.
Neither decides which scopes are allowed, rates an answer, writes a grant, or audits.

## Switches kept at today's behavior

- **The file floor and `always`:** `alwaysAtFloor` in `common/domain/permission/floor-policy.ts`
  is on: the file floor offers and takes `always`, and an earlier `always` grant on a floor
  subject or a `delete-below` folder clears its ask. Off, the floor neither offers, takes, nor
  reads `always`. A destructive command never takes `always`.
- **The dangerously-allow switch:** each mode's reach is a row of `DANGEROUSLY_ALLOW_REACH`.

## What remote backends will need

- **Routes, first:** each ask records its routes in the ledger, then a routing policy in node
  config. Today every ask reads as sent down `TODAYS_ROUTES`.
- **Signed decisions:** the signed `DecisionInput`, proof verifiers, a nonce claim per
  statement, a kept `decisionId`, approvers derived from the proof, and a `moot` receipt.
- **Delivery:** serve alone holding remote connections under a lease, a durable submit queue,
  backend refs in the ledger, and `renewed` events.
- **Grants:** `host.grants` to list and revoke a source's grants, and an expiry on every lasting
  grant a remote source makes.
- **Egress:** an `AskSummary` for a notify route.
- **Startup:** refusing a configured source named after a built-in id, which the guard
  routes nothing.

A pushed backend runs the contract kit in `test/support/approval-backend-kit.ts`, as the
terminal does; the pulled forms have `test/forms-backend.test.ts`.
