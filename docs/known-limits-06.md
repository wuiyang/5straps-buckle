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
- Shell text, a shell's `-c` text or a `script_run` bash body, is rated only when it is one simple
  command: one statement, with no list or pipe (`;`, `&&`, `||`, `|`, `&`, or a second line), no
  group, subshell, function, loop, or condition, and no substitution or expansion; it may carry
  leading assignments, one input (a file, a heredoc, or a here-string), and output redirections,
  and its command, behind `env`, `timeout`, `nice`, `nohup`, `stdbuf`, `exec`, or `command`, is the
  interpreter. Anything else is not rated: `cat job.py | python3`, `cd sub && node x.js`, and
  `python3 $(echo a).py` each ask a person, and an allowed command under `approval.quickJudge all`
  then runs unscreened. A here-string is read only in bash, rbash, zsh, ksh, mksh, and yash text.
  The `-c` text of a C shell, fish, or a busybox shell applet is never rated, nor text a shell runs
  with an option such as `-i`, `-l`, `-k`, or `-x`, nor `flock -c` text, which runs under `$SHELL`.
  In zsh text a `<` before a digit or `-` is a numeric glob (`python3 <0-9>.py`), so it is not rated.
- A call over 160 KiB of JSON is not sent to Jev; the thorough model may still rate it.
- A call that changes its working directory anywhere in it (`cd`, `chdir`, `pushd`, `env -C`,
  `sudo -D`, or `--cwd`), or sets a variable that changes what code runs (`PATH`, `NODE_OPTIONS`,
  `PYTHONPATH`, `SHELL`, `HOME`, and an exported bash function among them), is not rated, with the
  same result. A wrapper that sets the program name an interpreter reads (`exec` with an option, or
  `env -a` or `--argv0`) is not rated either; `exec` is read only bare.
- The reader fails closed on what it does not model, with the same result: an interpreter option it
  does not know, an option before a runner's package, or before the operand of a package that is no
  runtime (`npx eslint --fix .`); a subcommand that runs code it does not follow (`bun test`,
  `deno task`, `bun x`, or node's `inspect` and `debug`); an interactive flag (`python3 -i`,
  `node -i -e`, `lua -i`, or `php -a`, including `php -a` after `-f`), and a debugger fed from
  standard input (`python3 -m pdb`); code on an input nothing on its statement feeds (`python3 -`);
  an import naming a URL, a path holding `?`, `#`, or `%`, or a relative import an ES module loader
  reads differently (a tab, a control, or a leading or trailing space); a runtime that loads
  variables from a file (`--env-file`); more than 256 variables set; a package.json or bunfig.toml
  it cannot parse whole; bun's config named any way but `--config=<file>`; `python3 -X` with a value
  it does not know (`pycache_prefix` among them); a script, import, or redirected file whose name
  holds a backslash and a slash; and a parenthesised import list over 200 lines. bun's global config
  file is not read; lua opens a file named `-` after `--`, so that is its script, not standard input.
- Compiled Python beside a module the reader would show (`__pycache__/<name>.*.pyc`, `<name>.pyc`,
  or an extension module), in a folder the reader cannot list, or moved by `-X pycache_prefix`, is
  not rated either, since Python may run it in place of the source. Python writes those caches
  itself, so a tree it has already run asks a person until they are removed. A runner that starts
  bun reads the bunfig preloads the direct call reads.
- `node .` at the root of the workspace or a mount asks: node tries the file beside that folder
  first, which lies beyond what the reader sees.
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
