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
made while the Socket lookup failed, whose verdict was not kept. `promptDigest` is the sha256 of the
model, the prompt, and the JSON sent, kept in place of them. The reasoning is the model's, with the
credentials the display hides hidden wherever it is kept or shown, the cache included, then cut to
2,000 characters (ending `[cut]` on a line of its own). The report to Rings does not carry the
verdict yet.

## Why no stage was shown a call

An `unavailable` reason says why no stage rated a command; the ask then goes to a person, and an
allowed command under `approval.quickJudge all` runs unscreened. Shell text is rated only as one
simple command, as [what it reads](judge-02.md) describes. Besides a variable that changes what
code runs, a change of working directory, code past the caps, and a file it cannot find or read,
the reader's reasons include: "shell text the reader does not rate whole", "an option the
reader does not know", "a subcommand the reader does not model", "an interactive flag reads
standard input as code", "a module that discovers or evaluates code the reader does not show",
"the code the interpreter runs comes from standard input the reader cannot place", "an import the
reader does not model", "the code runs compiled Python the reader cannot show", "a config file the
reader could not parse", "the interpreter is a program inside the workspace", "the call sets the
program name the interpreter reads", "the call splits a word into words the reader does not read
again", "the runner runs a package from a path or a source the reader does not show", and "the
package.json script the standard script names could not be read".

The shell-text reason also covers `flock -c` text, a heredoc a shell reads as its script (`busybox
sh <<EOF`), and, inside shell text, a wrapper that sets the program name or splits a word (`exec
-a`, `env -a`, `env -S`) and a quoted or `+=` command word that reads as an assignment. The
local-program reason covers a wrapper, a shell, and a runner named by a path inside the workspace or
a mount, any relative program path holding a separator, and a command word that reads as an
assignment. The interactive reason covers `php -a` after `-f` and `python3 -m pdb`, `code`,
`asyncio`, or `idlelib`; the module reason, `-m unittest`, `pytest`, `timeit`, `runpy`, `pydoc`,
`inspect`, `cProfile`, `profile`, `trace`, `doctest`, `pickle`, and `pickletools`, and a second
`-m`; the unknown-option reason, a `python3 -X` value off the reader's short list (`pycache_prefix`
and `frozen_modules` among them); the import reason, an ES module specifier holding a control, a
tab, or a leading or trailing space; and the compiled-Python reason, a folder the reader cannot
list. A reason is cut to 500 characters, never inside an escape it quotes.

`buckle approvals judge` refuses a call the policy now denies, asking no stage: "The policy now
denies this call; the decision AI never rates a deny".

What a rating costs is on [its cost](judge-04.md#cost), and the limits are on [Known
limits, part six](known-limits-06.md) and [part seven](known-limits-07.md).
