# The decision AI: what it keeps and shows

What the [decision AI](judge.md), the optional model check Buckle (the approval and sandbox
runtime on this machine) runs with the node's own keys, keeps and shows. Its two stages are Jev
(TypeSafe AI's quick decision model) and the thorough model behind an OpenAI-compatible endpoint.

## The cache

Each stage's verdict is kept under that stage's provider and model, the policy (its `updatedAt`
and its lists), the command, its inline code, each file read as its path with its sha256, each
package with its version, whether it was a standard script, the working directory, the mounts
with their access, the variables the call sets, and Buckle's summary of the call, which names its
network access. One byte changed in any file it reads, two files swapping contents, a package
upgraded, or a mount added or made writable, makes a new key, so all of the code is rated again.
A verdict is kept for 24 hours, in memory and in `judge-cache.json` in the workspace's state
directory, readable by the owner alone, at most 1,000 with the oldest dropped, so a restart keeps
them. A policy change empties it, and no failure is kept.

Socket's summaries are kept the same way, by package URL, for 24 hours, in `socket-cache.json`
beside it, at most 2,000. `buckle workspace judge-cache clear` empties both by hand.

## What an approver sees

Where a stage rated an ask and did not pass it, the ask goes out with its verdicts beside the whole
action. Every approver route reads the same line:

```text
  judge:    quick: warning (0.90, jev-1.13.0, 120 ms); thorough: danger (0.92, gpt-6-luna, 900 ms): It deletes the build folder and pushes to a remote.
```

With the thorough model alone the line is `danger (0.92, gpt-6-luna, 900 ms): <reasoning>`, and
with Jev alone `quick: danger (0.95, jev-1.13.0, 90 ms)`. Jev's model is the versioned one that answered.
The approval webhook carries a `judge` object beside each ask: the thorough model's `level`,
`confidence`, `model`, `reasoning`, and `latencyMs`, or `unavailable`, with Jev's verdict as
`quick`; `buckle approvals --json` carries the same inside the ask's `call`. An allowed command Jev
rated `danger` asks with the reason "The decision AI's quick stage rated this command danger, so a
person decides; nothing it says refuses a command".

## The audit entry

A call a stage ran carries `judge` with the thorough model's `provider`, `model`, `level`,
`confidence`, `reasoning`, `latencyMs`, and `promptDigest`, Jev's verdict as `quick` (`provider`,
`model`, `level`, `confidence`, `probabilities`, `latencyMs`), `passed: true`, and `passedBy`
naming the stage, and names `judge` among what allowed it. One a stage rated and did not pass
carries the same with `passed: false`, or `unavailable` in place of a verdict; Jev's verdict alone
stands where the thorough model was not asked. `flagged: true` marks an allowed command Jev turned
into an ask, and `screened: true` one it rated and let run. `promptDigest` is the sha256 of the
model, the prompt, and the JSON sent, kept in place of them. The reasoning is the model's, cut
to 2,000 characters (ending `[cut]`) wherever it is kept or shown, with the credentials the
display hides hidden. The report to Rings, the 5straps agent control plane,
does not carry the verdict yet.

## Cost

Jev costs $0.042 per million input tokens, and its output is free, so one rating of a few
thousand tokens costs a fraction of a cent. The thorough model costs what your gateway or provider
charges for one short request per distinct command and code. A Socket lookup counts against the
key's Socket quota. A kept verdict or summary costs nothing.

The limits are on [Known limits, part six](known-limits-06.md).
