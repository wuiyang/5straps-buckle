# Known limits, part six

What the [decision AI](judge.md), the optional model check Buckle (the approval and sandbox
runtime on this machine) runs with the node's own keys, does not yet do. The
[first part](known-limits.md) lists the other limits.

## Judgement

- A verdict is a model's judgement and can be wrong. In automated mode a `safe` at 0.8 or above
  runs the call with no person, from either stage; under `approval.quickJudge asks` or `all`, that
  includes a call the built-in floor or the destructive list asks about.
- Jev, TypeSafe AI's quick stage, writes no reasoning: an approver reads its level, confidence,
  and model alone.
- Prompt injection through the command, a comment, or a file it reads is bounded, not ruled out:
  a deny is never rated, nothing either model says refuses a call, and the thorough model's answer
  must echo the command exactly.
- A kept verdict outlives a change to the model behind the same name for up to 24 hours, or until
  `buckle workspace judge-cache clear`. An alias such as `jev-latest` moves when TypeSafe ships a
  release.

## Reading

- Third-party code is never read: a package in `node_modules` or `site-packages` runs unseen. Its
  name, its version, and Socket's view of it (a supply-chain security service) are what a stage
  sees, and Python packages carry no version.
- Imports are read by their text: a computed `require(name)`, an `importlib` call, and the imports
  of Perl, Ruby, PHP, or Lua code are not followed. Past 50 files or 512 KiB, no stage is asked.
- Code a pipe hands the interpreter is not read, as in `cat job.py | python3`: a stage reads the
  shell text alone. A here-string is read only in bash, rbash, zsh, ksh, mksh, and yash text, and a
  heredoc only on the interpreter's own statement, with no other heredoc before it on its line.
- A call over 160 KiB of JSON is not sent to Jev; the thorough model may still rate it.
- A call that changes its working directory anywhere in it (`cd`, `pushd`, `env -C`, `sudo -D`,
  or `--cwd`), or sets a variable that changes what code runs, is not rated: an ask goes to a
  person, and an allowed command under `approval.quickJudge all` runs unscreened.
- The reader fails closed on what it does not model, with the same result: an interpreter option it
  does not know, a runtime that loads variables from a file (`--env-file`), more than 256 variables
  set, a bunfig.toml it cannot parse, or a parenthesised import list over 200 lines. bun's global
  config file is not read.
- `npm`, `pnpm`, and `yarn` never ask on their own, so their standard scripts reach a stage only
  under `approval.quickJudge all` in automated mode, or when the destructive list names them.

## Elsewhere

- Socket is advisory and looks at 50 packages a rating; with no key, a timeout, or an error, the
  rating runs without it, and a verdict reached while its lookup failed is not kept.
- No local model ships with Buckle: point `BUCKLE_JUDGE_BASE_URL` at one that speaks OpenAI's API.
- No Rings view of the verdict yet: Rings, the 5straps agent control plane, drops the webhook's
  `judge` field in its approvals reader, and the report to Rings carries none.
- `buckle client approve`, the enrolled-device route, shows the level alone in the ask's reason:
  a signed challenge carries no verdict yet.
- No live call has been made yet to a real AI gateway, TypeSafe, or Socket: the built-in model name
  `gpt-6-luna` (a gateway may name it differently), Jev's answers, and Socket's organization route
  follow the published documentation and the tests' imitations. A failure of any of them is no
  verdict, so a call asks as before.
