# The decision AI: what it keeps and shows

What the [decision AI](judge.md), the optional model check Buckle (the approval and sandbox
runtime on this machine) runs with the node's own keys, keeps and shows. Its two stages are Jev
(TypeSafe AI's quick decision model) and the thorough model behind an OpenAI-compatible endpoint.

Each stage's verdict is kept for 24 hours, as [its cache](judge-04.md#the-cache) says.

## What an approver sees

Where a stage rated an ask and did not pass it, the ask goes out with its verdicts beside the whole
action. The serve terminal, `buckle approvals --watch`, `buckle approvals show`,
`buckle approvals judge`, `buckle approve`, and MCP elicitation read the same line:

```text
  judge:    quick: warning (0.90, jev-1.13.0, 120 ms); thorough: danger (0.92, gpt-6-luna, 900 ms): It deletes the build folder and pushes to a remote.
```

With the thorough model alone the line is `danger (0.92, gpt-6-luna, 900 ms): <reasoning>`, and
with Jev alone `quick: danger (0.95, jev-1.13.0, 90 ms)`. Jev's model is the versioned one that
answered. An ask at the destructive floor leads its line with "a command at the destructive floor
always needs a person", which no stage's verdict changes. The approval webhook carries a `judge`
object beside each ask: the thorough model's `level`, `confidence`, `model`, `reasoning`, and
`latencyMs`, or `unavailable`, with Jev's verdict as `quick` and the floor's line as `warning`;
`buckle approvals --json` carries the same inside the ask's `call`.
`buckle client approve`, the enrolled-device route, shows the level alone in the ask's reason,
because a signed challenge carries no verdict yet. Rings, the 5straps agent control plane, does not
show the verdict yet, because its approvals reader drops the webhook's `judge` field. An allowed
command Jev rated `danger` asks with the reason "The decision AI's quick stage rated this command
danger, so a person decides; nothing it says refuses a command".

The thorough model's pass lifts an interpreter ask, and the webhook is not called for it: the serve
terminal prints one info line naming the thorough stage, the model, the level, the confidence, and
the command as an approver would see it, credentials hidden. Jev's verdict never passes an ask.
Where another ask remains, such as `write_scope`, the line says the call still waits for it, and the
ask goes out as usual.

## The audit entry

A call the thorough model ran carries `judge` with its `provider`, `model`, `level`, `confidence`,
`reasoning`, `latencyMs`, and `promptDigest`, Jev's verdict as `quick` (`provider`, `model`,
`level`, `confidence`, `probabilities`, and `latencyMs`), `passed: true`, and `passedBy:
'thorough'`, and names `judge` among what allowed it. One a stage rated and did not pass
carries the same with `passed: false`, or `unavailable` in place of a verdict, its reason cut to 500
characters; Jev's verdict alone stands where the thorough model was not asked. `flagged: true` marks
an allowed command Jev turned into an ask, and `screened: true` one it rated and let run, recorded
`passed: false, screened: true` because no ask was passed. `socket: 'unavailable'` marks a rating
made while the Socket lookup failed, whose verdict was not kept. `changed: true` marks a pass whose
code changed before the program started, so the call did not run and a person decides, and
`codeUnread` names why the reader could not read a screened allowed command's code, which Jev then
rated on its command line. `promptDigest` is the sha256 of the model, the prompt, and the JSON sent,
kept in place of them. The reasoning is the model's, with the
credentials the display hides hidden wherever it is kept or shown, the cache included, then cut to
2,000 characters (ending `[cut]` on a line of its own). The report to Rings does not carry the
verdict yet.

## On request

```bash
buckle approvals judge <token>                    # both verdicts beside the whole action
buckle approvals judge <token> --approve-if-safe  # and approve it once on the thorough model's safe
```

The command prepares the call again from the arguments its ask kept, reads its code afresh, has
every stage that applies rate it, and prints the whole action as `buckle approvals show` does, with
each verdict, confidence, model, and the thorough reasoning. With `--approve-if-safe`, the
thorough model's `safe` at 0.8 or above approves once an interpreter ask, or an allowed command Jev
turned into an ask under `all`, recorded as decided by the thorough stage and its model and bound
to the code it rated: a retry after that code changed spends nothing and asks again. Jev's verdict
alone approves nothing, and an ask at the destructive floor never: the command prints the floor's
line. Where only Jev holds a key, an ask's line offers no approval on any route that shows it.
Anything else approves nothing and exits 0; no verdict exits 1. A call whose kept arguments hide a
credential is not rated ([why](#what-the-on-request-command-refuses)). Each run is audited. It takes
`--workspace <name>` and works in automated mode too.

## What the on-request command refuses

`buckle approvals judge` refuses a call the policy now denies, asking no stage: "The policy now
denies this call; the decision AI never rates a deny". It refuses one whose ask keeps its arguments
with a credential hidden, a URL's password or a `--token=` value, since the call cannot be rebuilt
from them: "The ask's recorded arguments hide a credential, so the decision AI cannot rebuild the
call to read it; approve or deny it yourself, or run the workspace in automated mode, which rates
the call as sent".

[Why it rates nothing](judge-05.md) lists what no stage is shown, and the reason it gives. What a
rating costs is on [its cost](judge-04.md#cost), and the limits are on [Known limits, part
six](known-limits-06.md) and [part seven](known-limits-07.md).
