# Policy: what Buckle reads

How Buckle, the approval and sandbox runtime on this machine, reads a command call for the
[command policy](policy.md#commands) and the
[destructive floor](approvals.md#the-destructive-floor).

## What Buckle reads

The deny list and the destructive floor judge every command a call runs: the call as typed; the
command behind a prefix such as `sudo`, `doas`, `env`, `nice`, `timeout`, `flock`, or `xargs`, or
behind leading `NAME=value` assignments; each statement of a shell body; `eval` text; the string
`su -c` runs, the remote command `ssh` sends, and its `ProxyCommand`, all read as shell text; each
`find -exec`, `-execdir`, `-ok`, and `-okdir` command; and heredoc bodies. Another program that
runs a command, such as `watch`, is judged by its own words only.

## Reading limits

Reading stops at the first of these:

- `READ_BUDGET`: 8,000,000 characters, 1,000,000 words, or 100,000 commands across every level.
- `MAX_DEPTH`: wrappers or shell bodies nested 8 levels deep.
- `MAX_SUBSTITUTIONS`: `$(...)` substitutions nested 4 deep in double quotes or heredoc text.
- A `find -exec` command that starts with a dash word, which `find` reads as its own option.
- An interactive session: `ssh` or `su` with no command, or `sudo -i`, `sudo -s`, or `doas -s`
  with none.
- A shell that takes its script from a pipe, a redirection, or `xargs`.

Past a limit the destructive floor asks, naming it; with a deny list the call is refused, since
the unread part might hold a denied command.

## Interpreters

Code run by `python`, `node`, `deno`, `bun`, `perl`, `ruby`, or `php` is unknown to Buckle, a
reading limit, until `buckle policy allow-interpreter <name>` makes that program an ordinary
command; version and help calls stay ordinary. Static grading of such code (safe, warn, danger,
unknown) comes after the first release.
