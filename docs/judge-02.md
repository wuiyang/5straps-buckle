# The decision AI: what it reads and sends

How the [decision AI](judge.md), the optional model check Buckle (the approval and sandbox runtime)
runs with the node's own keys, reads a command, and what leaves the machine. Both stages, Jev
(TypeSafe AI's quick decision model) and the thorough model, see the same thing.

## The code

For a command it rates, Buckle reads:

- the code the command line hands an interpreter: `python3 -c`, `node -e`, `perl -e`, an `awk`
  program, `deno eval`, and what feeds its input where it names no script or names `-`: a file
  (`python3 < job.py`), a heredoc's body, or a here-string in a shell that has them;
- the script, found as the interpreter finds it (node in node's own order: `node build` reads
  `build.js`, else a folder's `main` or index file; Python a folder's `__main__.py`), also after a
  leading `--`, and each module `-r`, `--require`, `--import`, `--preload`, or a bunfig.toml loads
  first, bunfig preloads for a runner that starts bun too;
- every other argument naming a file in the workspace or a mount, and the module `python3 -m` runs;
- every local file those import, transitively, each once: JavaScript and TypeScript `import`,
  `export ... from`, `import()`, and `require()` of a relative or absolute path, by node's own
  rules under node, else with the usual extensions, index files, and the `.ts` behind a `.js`;
  Python `import` and `from ... import` of a module beside the file or under the working
  directory, with each package's `__init__.py`; and shell `source` and `.`.

Shell text, a shell's `-c` text or a `script_run` bash body, is read only as one simple command:
one statement with no list, pipe, `&`, second line, group, loop, condition, substitution, or
expansion (`$`, a backtick, a glob, or a `~`). Leading assignments, one input (a file, a heredoc,
or a here-string), and output redirections may stand on it, and its command, behind `env`,
`timeout`, `nice`, `nohup`, `stdbuf`, `exec` (bare only), or `command`, must be the interpreter; it
is then read as that call typed directly. A wrapper that sets the program name or splits a word
(`exec -a`, `env -a`, `env -S`) is not read, nor a command word the rules would read as an
assignment (`"FOO"=x`, or `FOO+=x` in any shell), nor a heredoc a shell reads as its script, nor
one fed to another interpreter holding a line that starts with an interpreter's name, nor C shell,
fish, or `flock -c` text.

For an ask, it reads the interpreters the policy does not allow; for an allowed command under
`approval.quickJudge all` in automated mode, every interpreter it runs. A standard development
script's own code is not read, only what bun preloads; where it names a `package.json` script, that
script's text is shown as context.

It reads only what the agent could read without asking, through the file tools' checks. No stage
is asked where it cannot show the code that runs; an ask then goes to a person, and an allowed
command under `approval.quickJudge all` is rated on its command line alone. [Why it rates
nothing](judge-05.md) lists each case and the reason it gives.

## Packages and Socket

A third-party package (a bare specifier such as `lodash`) and the package `npx` runs is named with
its version: the `version` in the nearest `node_modules/<name>/package.json` above each importing
file, inside the workspace or mount, once per version found. Python packages are named alone. A
package's code is never read; Socket covers that risk.

Socket is a supply-chain security service that scores open source packages and raises alerts, such
as install scripts or known malware. Where the node holds `BUCKLE_SOCKET_API_KEY`, Buckle asks
Socket about each package version, at most 50 a rating (then `packagesTruncated` is set), and shows
both stages its six scores, from 0 to 1, and its alerts by type and severity.
Socket is advisory: with no key, a timeout of 10 seconds, or an error, each summary is empty and the
rating runs, and a verdict reached while Socket failed is not kept. Buckle sends Socket the package
URLs alone, with the key as HTTP basic auth.

## What leaves the machine

One request per stage and rating, to the endpoint the node names, holding one JSON document: the
command as an approver sees it, credentials hidden, and its words; the interpreters named; the
inline code; the variables the call sets, each value as given with a secret's hidden; each file
read (its sandbox path `/workspace/...`, sha256, size, and content); the packages with their
versions and Socket's view; whether it is a standard script, and the text of the `package.json`
script it names; the command lists; the working
directory and mounts as the sandbox names them; and Buckle's summary of the call. So the
workspace's own scripts leave the machine. Never: a value from the node's own environment, a file
the agent could not read, a token, or a key in the body (each key goes in its `Authorization`
header). A host path the agent typed stays in the command.

Jev's size cap and both stages' instructions are on [the next page](judge-04.md).

## Failing closed

Every failure is no verdict, and no verdict never runs a call: a timeout (20 seconds for the
thorough model, its one retry included; 5 seconds an attempt for Jev, retried once), a network
error, an HTTP error, a refusal, a non-verdict answer, a wrong echo, code past the caps, or a
missing key.