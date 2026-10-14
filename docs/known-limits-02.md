# Known limits: programs Buckle runs

What Buckle, the approval and sandbox runtime on this machine, does not yet handle in the programs
it starts itself, such as `rg`, `git`, and `agent-browser`, a browser for agents. It follows
[Known limits](known-limits.md), which covers reading commands, credential hiding, and paths.

## Where programs come from

- Buckle runs each program it needs, such as `rg`, `git`, the sandbox program `bwrap`, or the
  environment validator, from where `PATH`, or a place it looks after `PATH`, really leads, and
  refuses one an agent could have written: one found in, or through a link in, any workspace or
  scratch root this node knows, whichever workspace runs it. `BUCKLE_MOUNTS` shares folders
  read-only, so a program there runs. `npx` and `pnpm exec` put a workspace's `node_modules/.bin`
  first on `PATH`, so an `rg` there leaves content search out of every workspace, and a `bwrap`
  there leaves no sandbox: the shell tools are withheld rather than run without one. A node
  started while its workspace registry cannot be read runs no program: repair the registry, then
  restart the node.
- Each program Buckle runs gets a `PATH` with those places taken out, so a script it runs that
  starts `#!/usr/bin/env node` never finds a `node` an agent planted. The shell keeps the agent's
  `PATH`.
- After `PATH`, Buckle looks beside its own `buckle` command, as npm lays out a global install,
  beside the Node.js it runs on, and on Windows in `%APPDATA%\npm`. A program another installer
  put elsewhere is found only on `PATH`.
- A running workspace keeps the programs it found: a workspace registered later counts for them
  from the running one's next policy change, or for the sandbox program, its next start.
- A program outside every root that hard-links a file inside one runs, as Buckle cannot see a
  file's other names: keep such links off `PATH`.
- The git tools refuse a repository reaching outside the workspace or scratch root holding the
  folder named, such as a home folder kept in git, a bare repository, or one whose git directory
  lies elsewhere.

## Windows shims

- npm installs a command on Windows as a `.cmd` shim, a small batch file that Node.js starts only
  through `cmd.exe`, which Buckle never runs: the agent's arguments would pass through its quoting.
  Buckle reads the shim instead, at most 64 KiB, and runs the `.exe` it names, or the script it
  names under Buckle's own Node.js. A `.exe` or `.com` of the same name in any place wins.
- Buckle reads the forms npm, pnpm, and agent-browser's own install write, and runs what the shim
  starts, nothing else. A shim that also sets an environment variable, such as pnpm's `NODE_PATH`,
  passes arguments or Node.js flags of its own, or starts its script with a program other than
  Node.js is refused rather than run without them, and so is any other shim, such as one that runs
  `/bin/sh`. The reason names the shim's file, never its folder: point the setting, such as
  `BUCKLE_AGENT_BROWSER_COMMAND`, at the `.exe` or the script inside the package, which Buckle's
  own Node.js then runs.
