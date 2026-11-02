# Rings (optional)

Rings is a separate 5straps control plane for agents, not part of this repository. Buckle, the
approval and sandbox runtime on your machine, can pair with it so Rings can call the node, hear
about pending approvals, and keep a copy of the action log. Nothing on this page is required:
every setting here is unset by default, and Buckle runs, asks, and logs without it.

## Pairing

```bash
buckle init --pair <code> --rings https://rings.example.com --url http://my-node.example.com:4320
```

`--pair` redeems a single-use code issued in Rings. Buckle posts the code to Rings with the
node's name, the workspace's manifest, the URL Rings should call it at, the workspace's agent
token, and the node's `BUCKLE_ADMIN_TOKEN`, so Rings can call tools there and reach the setup face.
`--url` defaults to `http://127.0.0.1:<port>`, which only a Rings on the same machine can reach.
Rings answers with a report credential, and possibly an approval key, which Buckle writes into
`buckle.env` without printing them. On a node set up already, `--pair` keeps its settings, mints
the workspace a token for Rings, and updates the URL. Restart a running `buckle serve` afterwards,
or run `buckle service restart` where a service runs it.

## Settings

Pairing fills these in. You can also set them by hand, to Rings or to any endpoint of your own.

| Setting | What it does |
|---|---|
| `BUCKLE_REPORT_URL` | where Buckle posts its action log; pairing sets `<rings>/api/v1/buckle-reports` |
| `BUCKLE_REPORT_TOKEN` | the bearer token for those posts and for the approval webhook; Buckle refuses to start when only one of the two report settings is set |
| `BUCKLE_APPROVAL_WEBHOOK` | where Buckle announces pending approvals; pairing sets `<rings>/api/v1/buckle-approvals` |
| `BUCKLE_RINGS_APPROVAL_KEY` | the key Rings minted at pairing; with it, posts to Rings are sealed, and decisions from Rings must arrive sealed |

These URLs are the owner's configuration, so the egress rules that judge an agent's network
access do not apply to them. Change one, then restart `buckle serve` (`buckle service restart`
where a service runs it) or `buckle mcp`.

### The action log report

With `BUCKLE_REPORT_URL` set, the [audit log](audit-log.md) entry for each tool call's result,
and for each dangerously-allowed use, is queued and posted in batches of up to 100. A batch goes
out 5 seconds after its first entry, or as soon as 100 wait, with up to 3 attempts. The queue
holds 500 entries and drops the oldest past that. A refused call is also posted on its own as it happens.
Each report carries the entry as the local log keeps it, which for a file copy includes its path and
sha256, plus the workspace root and, for a refused call, its rule, subject, and reason. Posting never holds up a call, and a batch that
cannot be delivered is still in `actions.jsonl`.

### Approval webhook

With `BUCKLE_APPROVAL_WEBHOOK` set, Buckle posts each new ask to that URL, naming the node
(`serverId`) and the workspace, and for each ask its token, tool, rule, subject, reason, expiry,
offered scopes, and the `buckle approvals` and `buckle approve` commands that review and answer
it. With `BUCKLE_RINGS_APPROVAL_KEY` set, the post also carries the whole call, redacted as an
approver sees it. Later posts to the same URL say what became of each ask: answered, denied,
expired, cancelled, or skipped because the call stopped waiting. A post times out after 5 seconds,
and a failure is logged without failing the call.

Any receiver works, Rings or a chat relay. The webhook only announces; it never decides.

## What Rings cannot do

Rings holds the agent token, so it can call tools like any agent and meets the same policy and
questions. Holding the admin credential opens the setup face only when the node sets
`BUCKLE_EXPERIMENTAL_ADMIN_HTTP=true`. There, a decision Rings relays can deny an ask, but an
approval needs a person: at the node's own terminal, or through a device key the owner enrolled
with `buckle keys enroll`. No HTTP route reads or changes the node settings, and only the local
CLI sets the dangerously-allow switch.
