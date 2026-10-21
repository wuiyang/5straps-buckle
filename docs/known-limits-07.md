# Known limits, part seven

More of what the [decision AI](judge.md), the optional model check Buckle (the approval and sandbox
runtime on this machine) runs with the node's own keys, does not yet do, after
[part six](known-limits-06.md). The [first part](known-limits.md) lists the other limits.

## Programs the agent may have placed

- A program a call runs is the file its typed word names, so none the agent could have placed is
  rated: an interpreter, a wrapper such as `env`, `nice`, or `timeout`, a shell, or a runner such
  as `npx`, named by a path inside the workspace or a mount (`./fv/bin/env python3 job.py`,
  `./fv/bash -c 'python3 job.py'`), typed directly, behind another wrapper, or in shell text. Such a
  runner is never a standard script (`./bin/npx vitest run`). An absolute path outside the
  workspace and every mount is still rated (`/usr/bin/env python3 job.py`, `/bin/bash -c`), but
  one that names no file is not.
- Any relative program path holding a separator is not rated, even one that seems to leave the
  workspace: the sandbox runs the call at `/workspace` under a root holding each mount at its
  target, so `../data/fv/bin/python3` reaches the mount at `/data`, and `../workspace/x` the
  workspace itself.
- A command word that reads as an assignment is not rated: a direct call of `FOO=1 python3 job.py`
  runs a program named `FOO=1`, and a wrapper that runs its command (`nice FOO=1 ...`) does the
  same. In shell text, `"FOO"=x`, `F\OO=x`, `'FOO=x'`, and `FOO+=x` are the program a shell runs,
  so they ask a person under every shell, though bash and zsh apply `FOO+=x` as an assignment.
- A runner package named by anything but a registry name, with an optional version or range, is
  not rated: a path (`./tool`, `/abs`, `~/tool`), `file:`, `link:`, a git or other scheme, GitHub
  shorthand (`user/repo`), or a tarball, alone or after the name's `@` (`npx tsx@file:./tool`).

## Over-refusals kept

- A `-m` anywhere after a Python script is read as a module, so `python3 job.py -m pdb` asks a
  person, though Python hands those words to the script.
- A heredoc fed to an interpreter other than a shell, holding a line that starts with an
  interpreter's name (`python3 - <<'EOF'` with a line `node build.js`), asks a person: the rules
  read that line as a command.
- A standard script inside shell text that is not one simple command (`bash -c 'echo hi; npx vitest
  run'`) asks a person, as a bun one already did.
- A standard script naming a `package.json` script asks a person where the working directory's
  `package.json` is missing, cannot be read or parsed, or holds no such script; npm would fail too.

## Not yet read

- A project `.npmrc` holding `node-options` preloads code under `npx` with no variable set, and one
  holding `workspace=` or `workspaces=` runs another package's script under `npm run` with no option
  typed; the reader does not read `.npmrc`. Writing one asks, as a sensitive file does.
- `pnpm_config_*` is not a code-loading name: pnpm 10.33.2 ignored `pnpm_config_node_options`,
  while `npm_config_node_options` reached its scripts and is refused.

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
