# Sandbox and tools, part two

More of how Buckle, the approval and sandbox runtime on your machine, runs its tools: host Git,
forge, and language servers, the browser's allowed hosts, how `web_fetch` follows redirects, and the
change history. [Part one](sandbox-and-tools.md) covers the packs, sandboxing per platform, and shell
isolation.

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

## Fetching URLs

`web_fetch` follows up to five redirects, one hop at a time, and checks every hop against the
[approved list](policy.md#network) and the permission rules. It follows each answer as a
browser would:

- A 303 answer to any method but GET or HEAD, and a 301 or 302 answer to a POST, is followed with
  GET and no body. The request's `content-type`, `content-length`, `content-encoding`,
  `content-language`, and `content-location` headers go with the body.
- A 307 or 308 answer repeats the method and the body.
- A hop to another origin (scheme, host, or port) drops the `authorization`, `cookie`, and
  `proxy-authorization` headers, and a later hop back to the first origin does not restore them.

The result's `body` holds the first 2 MiB of the response at most. `truncated` is set when the
response held more than that, whether its `content-length` said so or a byte followed the 2 MiB.
A `content-length` on a compressed response counts the compressed bytes, so it is ignored there.
A response of exactly 2 MiB is not truncated. A response that neither ends nor sends more for a
second after the 2 MiB, or fails there, is not shown complete, so it is marked truncated too, and
the 2 MiB already read is returned.

## Change history

Tool writes and shell publications are recorded as checkpoints under `history/`, kept up to
`BUCKLE_HISTORY_MAX_BYTES` (1 GiB) and `BUCKLE_HISTORY_RETENTION_DAYS` (30):

```bash
buckle history list
buckle history restore <id>
```

## Host Git, forge, and language servers

These run on the host, outside the sandbox. Buckle judges the repository a call names, and each
path `git_diff`, `git_log`, `git_blame`, and the language servers name, but not the paths
`git_commit` stages or every file they read, so they start off. Turn them on for a repository you
trust:

```bash
buckle workspace set packs.hostGit on    # the git and forge packs
buckle workspace set packs.hostLsp on    # language servers in the dev pack
```

Each applies to that workspace alone. A filesystem `deny` or `ask` rule in its policy withholds
all three packs again.

`git_diff` and `git_log` judge each path they name as a read, as `git_blame` judges its file, so
a named `.env` asks. git reads each path literally, never as a
pattern, and a path outside the repository is refused. A `git_diff` naming no path, or a folder,
judges each file it lists: one the rules keep from the agent, such as a `.env`, shows its header
and line counts, not its content. A `git_log` naming no path lists every file's commits
([known limits](known-limits-02.md#where-programs-come-from)).

Each `git` pack call runs against
the repository Buckle checked: git is handed the git directory, work tree, and common directory
that check found, and the call is refused when any of them changes before or while git runs. It
shows nothing of a submodule's changes or history: Buckle tells git to ignore submodules, but git
still opens a submodule's `HEAD`, config, and refs to compare the recorded commit, and an error
there can name that place ([known limits](known-limits-02.md#where-programs-come-from)). A
repository whose `objects/info/alternates` file borrows objects from outside the workspace and its
mounts is refused too; for a repository outside them that you approved reading, its own folder
counts as well. The forge pack gets neither check
([known limits](known-limits-04.md#the-forge-pack)).

Every `git` and `forge` call hides the system and global git configs, points `core.hooksPath` at
an empty directory Buckle owns, and overrides the repository's program settings, so no
repository hook or configured program runs. The forge pack holds `BUCKLE_FORGE_GITHUB_TOKEN`
in git's environment, never in a remote URL, and talks to `BUCKLE_FORGE_GITHUB_API_URL`
(`https://api.github.com` by default). `git_push` refuses force and pushes only to the origin the
rules judged; commits carry `BUCKLE_FORGE_GIT_AUTHOR`.
