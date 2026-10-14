# Known limits: programs Buckle runs

What Buckle, the approval and sandbox runtime on this machine, does not yet handle in the programs
it starts itself, such as `rg` and `git`. It follows [Known limits](known-limits.md), which covers
reading commands, credential hiding, and paths.

## Where programs come from

- Buckle runs each program it needs, such as `rg`, `git`, the sandbox program `bwrap`, or the
  environment validator, from where `PATH` really leads, and refuses one an agent could have
  written: one found in, or through a link in, any workspace or scratch root this node knows,
  whichever workspace runs it. `BUCKLE_MOUNTS` shares folders read-only, so a program there
  runs. `npx` and `pnpm exec` put a workspace's `node_modules/.bin` first on `PATH`, so an
  `rg` there leaves content search out of every workspace, and a `bwrap` there leaves no sandbox:
  the shell tools are withheld rather than run without one. A node started while its workspace
  registry cannot be read runs no program: repair the registry, then restart the node.
- Each program Buckle runs gets a `PATH` with those places taken out, so a script it runs that
  starts `#!/usr/bin/env node` never finds a `node` an agent planted. The shell keeps the agent's
  `PATH`.
- A running workspace keeps the programs it found: a workspace registered later counts for them
  from the running one's next policy change, or for the sandbox program, its next start.
- A program outside every root that hard-links a file inside one runs, as Buckle cannot see a
  file's other names: keep such links off `PATH`.
- The git tools refuse a repository reaching outside the workspace or scratch root holding the
  folder named, such as a home folder kept in git, a bare repository, or one whose git directory
  lies elsewhere.
