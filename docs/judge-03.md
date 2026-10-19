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
them. A policy change empties it. No failure is kept, nor a verdict reached while the Socket lookup
failed.

Socket, a supply-chain security service that scores open source packages, has its summaries kept
the same way, by package URL, for 24 hours, in `socket-cache.json` beside it, at most 2,000.
`buckle workspace judge-cache clear` empties both by hand.

## What an approver sees

Where a stage rated an ask and did not pass it, the ask goes out with its verdicts beside the whole
action. The serve terminal, `buckle approvals --watch`, `buckle approvals show`,
`buckle approvals judge`, `buckle approve`, and MCP elicitation read the same line:

```text
  judge:    quick: warning (0.90, jev-1.13.0, 120 ms); thorough: danger (0.92, gpt-6-luna, 900 ms): It deletes the build folder and pushes to a remote.
```

With the thorough model alone the line is `danger (0.92, gpt-6-luna, 900 ms): <reasoning>`, and
with Jev alone `quick: danger (0.95, jev-1.13.0, 90 ms)`. Jev's model is the versioned one that
answered. The approval webhook carries a `judge` object beside each ask: the thorough model's
`level`, `confidence`, `model`, `reasoning`, and `latencyMs`, or `unavailable`, with Jev's verdict
as `quick`; `buckle approvals --json` carries the same inside the ask's `call`.
`buckle client approve`, the enrolled-device route, shows the level alone in the ask's reason,
because a signed challenge carries no verdict yet. Rings, the 5straps agent control plane, does not
show the verdict yet, because its approvals reader drops the webhook's `judge` field. An allowed
command Jev rated `danger` asks with the reason "The decision AI's quick stage rated this command
danger, so a person decides; nothing it says refuses a command".

A stage's pass lifts that command's ask, and the webhook is not called for it: the serve terminal
prints one info line naming the stage, the model, the level, the confidence, and the command as an
approver would see it, credentials hidden. Where another ask remains, such as `write_scope`, the
line says the call still waits for it, and the ask goes out as usual.

## The audit entry

A call a stage ran carries `judge` with the thorough model's `provider`, `model`, `level`,
`confidence`, `reasoning`, `latencyMs`, and `promptDigest`, Jev's verdict as `quick` (`provider`,
`model`, `level`, `confidence`, `probabilities`, and `latencyMs`), `passed: true`, and `passedBy`
naming the stage, and names `judge` among what allowed it. One a stage rated and did not pass
carries the same with `passed: false`, or `unavailable` in place of a verdict, its reason cut to 500
characters; Jev's verdict alone stands where the thorough model was not asked. `flagged: true` marks
an allowed command Jev turned into an ask, and `screened: true` one it rated and let run, recorded
`passed: false, screened: true` because no ask was passed. `socket: 'unavailable'` marks a rating
made while the Socket lookup failed, whose verdict was not kept. `promptDigest` is the sha256 of the
model, the prompt, and the JSON sent, kept in place of them. The reasoning is the model's, with the
credentials the display hides hidden wherever it is kept or shown, the cache included, then cut to
2,000 characters (ending `[cut]` on a line of its own). The report to Rings does not carry the
verdict yet.

## Why no stage was shown a call

An `unavailable` reason says why no stage rated a command; the ask then goes to a person, and an
allowed command under `approval.quickJudge all` runs unscreened. Shell text is rated only as one
simple command (one statement, at most one input, no pipe, list, group, substitution, or
expansion), as [what it reads](judge-02.md) describes. Besides a variable that changes what code
runs, a change of working directory, code past the caps, and a file it cannot find or read, the
reader's reasons include: "shell text the
reader does not rate whole", "an option the reader does not know", "a subcommand the reader does
not model", "an interactive flag reads standard input as code", "the code the interpreter runs
comes from standard input the reader cannot place", "an import the reader does not model", "the
code runs compiled Python the reader cannot show", and "a config file the reader could not parse".
The shell-text reason also covers `flock -c` and a wrapper that sets the program name (`exec -a`,
`env --argv0`); the interactive reason covers `php -a` after `-f` and a debugger fed its input; the
compiled-Python reason covers a folder the reader cannot list and `-X pycache_prefix`. A reason is
cut to 500 characters, never inside an escape it quotes.

## Cost

Jev costs $0.042 per million input tokens, and its output is free, so one rating of a few
thousand tokens costs a fraction of a cent. The thorough model costs what your AI gateway or provider
charges for one short request per distinct command and code. A Socket lookup counts against the
key's Socket quota. A kept verdict or summary costs nothing.

The limits are on [Known limits, part six](known-limits-06.md).
