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
  shell text alone. A here-string is read only in bash, zsh, and ksh text.
- A call over 160 KiB of JSON is not sent to Jev; the thorough model may still rate it.
- `npm`, `pnpm`, and `yarn` never ask on their own, so their standard scripts reach a stage only
  under `approval.quickJudge all`, or when the destructive list names them.

## Elsewhere

- Socket is advisory and looks at 50 packages a rating; with no key, a timeout, or an error, the
  rating runs without it.
- No local model ships with Buckle: point `BUCKLE_JUDGE_BASE_URL` at one that speaks OpenAI's API.
- No Rings view of the verdict yet: the report to Rings, the 5straps agent control plane, carries
  none.
