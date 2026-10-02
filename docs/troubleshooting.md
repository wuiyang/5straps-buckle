# Troubleshooting

The failures people meet first with Buckle, the approval and sandbox runtime on their machine,
each with the message it prints and the fix. Buckle logs as JSON lines on stderr; a one-shot
command prints its reason on one line and exits 1.

## node-pty was not built

Interactive terminals answer HTTP 503 with:

```
Interactive terminal support is unavailable on this Buckle installation
```

Everything else works. `node-pty` is an optional dependency used only for these terminals. On
Linux it compiles from source during install, so an npm set to skip install scripts
(`ignore-scripts=true`) leaves it unbuilt; macOS and Windows get a prebuilt binary. Install a C++
toolchain, make, and Python, then reinstall with scripts on, and check that it loads:

```bash
npm i -g @5straps/buckle --ignore-scripts=false
cd "$(npm root -g)/@5straps/buckle" && node -e "require('node-pty')"
```

In a clone, `pnpm rebuild node-pty`. Terminals also need bubblewrap.

## Shell tools are missing

`buckle tools` lists no `shell exec`, and `buckle manifest` gives the shell pack's reason:

| Reason | Fix |
|---|---|
| `Isolated shell execution requires bubblewrap; BUCKLE_SHELL_ISOLATION=false opts into shared-workspace checkpoints` | on Linux, install bubblewrap; on macOS, add `BUCKLE_SHELL_ISOLATION=false` to `buckle.env` |
| `No process sandbox is available here, so shell tools are withheld. Install bubblewrap (Linux) or set BUCKLE_SANDBOX=none to run commands unsandboxed on purpose.` | install bubblewrap, or accept unsandboxed commands with `BUCKLE_SANDBOX=none` |
| `The workspace is mounted at /workspace, which needs bubblewrap; shell tools are withheld under the seatbelt sandbox rather than shown a different view` | on macOS, `buckle settings unset mount` |
| `Shell tools are turned off by BUCKLE_ALLOW_SHELL=false` | `buckle settings set shell on` |
| `BUCKLE_SANDBOX=bubblewrap was requested but bwrap is not installed` | install bubblewrap, or set `BUCKLE_SANDBOX=auto` |

Restart `buckle serve` or `buckle mcp` after the change. [Sandbox and tools](sandbox-and-tools.md)
explains each mode.

## The port is in use

`buckle serve` exits 1 after a log line like:

```json
{"level":"fatal","component":"buckle","message":"Buckle failed to start","error":{"code":"EADDRINUSE","message":"listen EADDRINUSE: address already in use 127.0.0.1:4320"}}
```

Another process holds port 4320, often an earlier `buckle serve`. Stop it, or pick another port
for this start with `BUCKLE_PORT=4321 buckle serve`, or edit the `BUCKLE_PORT` line in
`buckle.env`. The shell's value wins over the file's.

## The state directory has the wrong modes

Buckle creates `~/.5straps/buckle` with mode 700 and its files with mode 600. When the settings
file is readable by others, it still starts and logs a warning:

```
The environment file /home/you/.5straps/buckle/buckle.env can be read by other users; run chmod 600 /home/you/.5straps/buckle/buckle.env
```

When it cannot read a state file, for example one written by another user or through `sudo`, it
refuses:

```
State file is unreadable or invalid: /home/you/.5straps/buckle/approvals.json; owner repair is required
```

Give the files back to the user who runs Buckle and close them to everyone else:

```bash
sudo chown -R "$USER" ~/.5straps
chmod -R go-rwx ~/.5straps
```

The same message names a file whose JSON is damaged; restore it from a backup or remove it, which
loses what it held. A state directory inside the workspace root is refused at start with
`BUCKLE_STATE_DIR is ..., inside the BUCKLE_WORKSPACE_ROOT at ...`; move one of them.

## A push is refused by the receive guard

When `origin` is a repository on the same machine, `git_push` checks it before the push, and
again inside the receiving git through a guard that is that git's only hook. Both refuse when git
would write somewhere other than the repository Buckle judged: a `.git` that is a file or a
symbolic link, a `commondir` or `gitdir` pointer file, or a symbolic link in the git directory,
its `objects`, `refs`, or `logs`. The agent sees:

```
PERMISSION_DENIED: /home/you/repos/app/.git is a file pointing git at another repository, so git would write somewhere the permission rules never judged; push to the real repository by its own path (set origin to it) so the permission rules judge it
```

Point `origin` at the real repository directory, for example with
`git remote set-url origin /home/you/repos/app-main`, and push again. If the message instead
says the guard `cannot be run`, its execute permission was lost or the state directory sits on a
`noexec` mount: restore the permission, or move the state directory with `BUCKLE_STATE_DIR`.

## A bash script is refused

```
PERMISSION_DENIED: A shell wrapper hides its command from the word globs, so it needs an allow rule of its own: buckle policy allow-command 'bash -c *'
```

`script_run` with the `bash` runtime, and any `bash -c`, is refused until a rule allows the
wrapper. Prefer `shell_exec` with the program and its arguments, or allow the wrapper as the
message says. [Policy](policy.md#commands) explains why.

## A .env in the project is refused

```
/home/you/code/app/.env sets BUCKLE_ variables, but Buckle never reads the working directory: its settings live in /home/you/.5straps/buckle/buckle.env, or in the file BUCKLE_ENV_FILE names. Run `buckle init` to write them there, or set BUCKLE_ENV_FILE to this file.
```

Buckle reads settings only from the state directory or `BUCKLE_ENV_FILE`. Run `buckle init`,
or point `BUCKLE_ENV_FILE` at the file.

## buckle approve will not approve

```
Not approved: buckle approve records an approval only after a person at a terminal confirms the action above, and this process's input and output are not both a terminal. ...
```

Run it in an interactive terminal, without redirecting its input or output, and type `yes`.
`buckle approve <token> --deny` works anywhere.
