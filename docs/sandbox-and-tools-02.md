# Sandbox and tools, part two

More of how Buckle, the approval and sandbox runtime on your machine, runs its tools: the
browser's allowed hosts and the change history. [Part one](sandbox-and-tools.md) covers the packs,
sandboxing per platform, shell isolation, and host Git.

## The browser's allowed hosts

`browser_command` runs one `agent-browser` command in a session of its own, headless unless
the workspace sets `browser.headed` on. By default each session gets a fresh browser with no saved state; the
owner can choose a profile folder that keeps logins, or their own Chrome, as
[Using your own browser](browser-login.md) describes. No agent call can. The first call in a mode
launches the browser and may outlast a client's wait; the same call again reuses it.

The owner installs `agent-browser` outside any workspace (Buckle refuses one inside):
`npm i -g agent-browser`, then `agent-browser install`. Buckle
looks for it where it looks for every program ([Install](install.md#requirements)), reading, never
running, npm's `.cmd` shim on Windows. Without it, the pack's reason says where Buckle looked.

For a fresh browser with an approved list, Buckle passes its hosts to `agent-browser` as
`--allowed-domains`, so clicks, redirects, and page requests stay on them. The browser matches
host names only, so inside a page an allowed host is reachable on any port and path, while the
page a command opens is still judged with port and path. With no approved list, no flag is passed
and public hosts are open. When a list has no usable host, Buckle does not start the browser and
says which list to fix.

## Change history

Tool writes and shell publications are recorded as checkpoints under `history/`, kept up to
`BUCKLE_HISTORY_MAX_BYTES` (1 GiB) and `BUCKLE_HISTORY_RETENTION_DAYS` (30):

```bash
buckle history list
buckle history restore <id>
```
