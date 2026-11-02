# Troubleshooting

The failures people meet with Buckle, the approval and sandbox runtime on their machine,
each with its message and fix. Buckle logs text at terminals, JSON elsewhere; a
one-shot command prints its reason on one line and exits 1.
[Refused commands](troubleshooting-02.md), such as a shell wrapper, an interpreter, a call
Buckle cannot read whole, or a push the receive guard refuses, continue on the next page, and
[refused file calls](troubleshooting-03.md) on the one after.

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
| `Isolated shell execution requires bubblewrap; the workspace setting shell.isolation, off, opts into shared-workspace checkpoints` | on Linux, install bubblewrap; on macOS, `buckle workspace set shell.isolation off`, or `BUCKLE_SHELL_ISOLATION=false` in `buckle.env` for every workspace |
| `No process sandbox is available here, so shell tools are withheld. Install bubblewrap (Linux) or set BUCKLE_SANDBOX=none to run commands unsandboxed on purpose.` | install bubblewrap, or accept unsandboxed commands with `BUCKLE_SANDBOX=none` |
| `The workspace is mounted at /workspace, which needs bubblewrap; shell tools are withheld under the seatbelt sandbox rather than shown a different view` | on macOS, `buckle policy unmount` |
| `Shell tools are turned off in this workspace: its setting packs.shell is off` | `buckle workspace set packs.shell on` |
| `BUCKLE_SANDBOX=bubblewrap was requested but bwrap is not installed` | install bubblewrap, or set `BUCKLE_SANDBOX=auto` |

A `buckle.env` change applies when `buckle serve` (or, under a service, `buckle service restart`)
or `buckle mcp` restarts, and a workspace setting at the workspace's next call. [Sandbox and tools](../how-to/sandbox-and-tools.md) explains each mode.

## The port is in use

`buckle serve` exits 1 after logging:

```
22:22:00 [fatal] Buckle failed to start: Error: listen EADDRINUSE: address already in use 127.0.0.1:4320 (EADDRINUSE)
```

Another process holds port 4320, often an earlier `buckle serve`. Stop it, or start on another
port with `BUCKLE_PORT=4321 buckle serve`, or edit the `BUCKLE_PORT` line in
`buckle.env`. The shell's value wins over the file's.

## Buckle is already running in service mode

`buckle serve` prints this, starts nothing, and exits 1 where a node already serves the state
directory with no terminal, as the [service](../how-to/service-02.md) or `buckle serve --background` runs it.
Answer its approvals with the command it names: `buckle approvals --watch` in the workspace folder,
else `--all`. `buckle service status` shows it, and `buckle service stop` stops it, after which
`buckle serve` runs at the terminal.

## The state directory has the wrong modes

On Linux and macOS, Buckle creates `~/.5straps/buckle` with mode 700 and its files with mode 600.
When other users can reach the directory, every command, `buckle serve`, and `buckle mcp` refuse
to start:

```
Directory /home/you/.5straps/buckle is accessible to other users (mode 755); it holds credentials and must be owner-only: chmod 700 /home/you/.5straps/buckle, or pass --skip-owner-only-check to use it as it is
```

Run the `chmod` it names. Where modes cannot be set, for example on a Windows drive mounted in
WSL, add `--skip-owner-only-check` to the command, before or after the command word, as in
`buckle serve --skip-owner-only-check`. Buckle then logs one warning naming the directory and
starts. The flag covers the node's signing key and the device key of `buckle client` the same
way. On Windows, Buckle checks no modes at all.

When only the settings file is readable by others, Buckle starts and logs a warning:

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
loses what it held. A workspace folder holding the state directory is refused, with `A workspace
folder must not hold, or sit inside, another workspace or Buckle state`, or, for a 0.1 node
moving onto workspaces, `BUCKLE_STATE_DIR is ..., inside the BUCKLE_WORKSPACE_ROOT at ...`; move
one of them.

## The move onto workspaces stops partway

On Windows, the first command after an upgrade from 0.1 can stop with:

```
Buckle stopped moving the node onto workspaces partway: it could not move C:/Users/you/.5straps/buckle/history to C:/Users/you/.5straps/buckle/workspaces/<id>/history (EPERM), as a program still holds it, or a file inside it, open: most likely a buckle serve, a buckle mcp an MCP client started, the Buckle service, the browser Buckle opened (agent-browser and its Chromium), or an antivirus scan. ...
```

Stop every Buckle process (`buckle serve`, the Buckle service, and each MCP client that runs
`buckle mcp`) and the browser it opened: Ctrl-C the serve, run `buckle service stop`, and quit
each client. Then run the command again: the move continues where it stopped. Where another
Buckle process is still at work, the move refuses first, with `Buckle cannot move the node onto
workspaces while another Buckle process runs on this state directory: process 1234 ...`, and the
same fix applies.
[Moving a node from 0.1](../how-to/workspaces-04.md) says what moves.

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
