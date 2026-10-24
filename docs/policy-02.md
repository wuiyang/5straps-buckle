# Policy: what Buckle reads

How Buckle, the approval and sandbox runtime on this machine, reads a command call for the
[command policy](policy.md#commands) and the
[destructive floor](approvals.md#the-destructive-floor). [What stays unread](policy-03.md), and
the limits Buckle does not mark, continue on the next page.

## What Buckle reads

The deny list and the destructive floor judge every command a call runs:

- the call as typed, and the command behind a prefix: `sudo`, `doas`, `env`, `nice`, `nohup`,
  `time`, `timeout`, `stdbuf`, `ionice`, `chrt`, `setsid`, `flock`, `xargs`, `watch`, `command`,
  `exec`, `builtin`, `noglob`, `nocorrect`, zsh's `-`, zsh's `repeat` and its count, or leading
  `NAME=value` assignments;
- the applet `busybox` or `toybox` runs, so `busybox env git push` is read as `env git push`; a
  shell applet such as `busybox sh` is an [interpreter](#interpreters);
- each statement of a shell body (`-c` with `bash`, `sh`, `zsh`, `dash`, `ksh`, `fish`, `rbash`,
  `ash`, `mksh`, `yash`, or `posh`), of a heredoc body, and of `eval` text;
- the text `trap`, `alias`, and `mapfile -C` keep for the shell to run, and an alias's value where
  the same text uses its name;
- the string `su -c` runs and the remote command `ssh` sends, its words or a `RemoteCommand`, read
  as shell text, and the `ProxyCommand`, `LocalCommand`, or `KnownHostsCommand` an `ssh -o`
  setting runs locally;
- an `env -S` value with no backslash and no `${`, and a `sudo -s` or `-i` command of plain words
  (letters, digits, and `_@%+=:,./-`);
- each `find -exec`, `-execdir`, `-ok`, and `-okdir` command.

## A command written as a path

A rule names a command by its bare word: `git status` admits `git status`, not `./git status`,
`/usr/bin/git status`, or `bin/git status`, each of which runs the program at that path, which may
be one the agent placed. So does `FOO=./git status` where Buckle, `find`, or a prefix such as
`nice` runs it (the file `git` in a folder named `FOO=.`); opening a shell statement, or after `env`
or `sudo`, it is an assignment. Such a call, or a shell body holding one, asks at the
[destructive floor](approvals.md#the-destructive-floor) instead of running, with the whole call
shown, wherever only a bare-word allow glob names it. An allow glob that spells the path admits that
spelling: `buckle policy allow-command '/usr/bin/git status'`, or `'*/* *'` for any command written
as a path with `/`. Each alternative of a brace in the command word counts on its own, so
`{git,/usr/bin/git} status` admits those two and asks for `./git status`, and a path glob meets
only a path written plainly: no `.` or `..` step after a leading `./`, and no doubled slash. A
command word starting with `~`
is never written plainly either: a shell reads it from a home folder and a direct call from its
working folder, so spell the full path.

A pattern cannot hold `\`, so on Linux and macOS, where a backslash is part of a name, no allow
rule names a command written with one, such as `.\gradlew`. On Windows write it with `/`, or let
the rule spell `/`: `C:/Tools/git status` admits `C:\Tools\git status`.

A deny or destructive glob meets the command by its basename and as written, so `git push *` still
refuses `/usr/bin/git push`. With no allow list a path spelling runs as before, unless a deny or
destructive glob that spells the path meets it; such a glob matched nothing before.

## Reading limits

Where reading stops, the call is unread. With a deny list it is refused, since the unread part
might hold a denied command; with none, the destructive floor asks. The refusal names the limit:

| The refusal names | For example | What to do |
|---|---|---|
| `MAX_DEPTH` | wrappers or shell bodies nested more than 8 deep | run the inner command directly |
| `READ_BUDGET` | over 8,000,000 characters, 1,000,000 words, or 100,000 commands | split the work into smaller calls |
| `MAX_SUBSTITUTIONS` | five `"$(...)"` nested inside double quotes | set the inner value in a statement of its own, `v="$(...)"` |
| find primary | `find . -exec -name x \;` | start the command with the program it runs |
| comment | `case $x in a) true;; esac; echo $(true)#x` | put a blank before the `#` |
| interactive session | `ssh host`, `su deploy`, or `sudo -s` with no command | give it the command, `ssh host uptime` |
| expansion | `$cmd push`, `eval "$x"`, `bash -c "$(cat job.sh)"`, `nice -n $n make` | spell the command out, or quote a value after an option that takes one, `nice -n "$n" make` ([expansions](policy-03.md#expansions)) |
| own parsing | `env -S 'a\_b'`, a `%r` in an `ssh` `ProxyCommand`, `sudo -s $'a\nb'` | write the value with no escape, `%` token, or quoting of its own |
| script as data | `cat job.sh \| bash`, `bash < job.sh`, `xargs bash`, `BASH_ENV=<(...) bash -c true` | hand the shell its text with `-c` or a heredoc on its own statement |
| unknown interpreter | `python3 -c 'print(1)'` | allow it, as below |

[Troubleshooting](troubleshooting-02.md#a-call-buckle-cannot-read-whole-is-refused) shows a
refusal in full.

## Interpreters

Code run by `python` (and `pypy`), `node` and `nodejs`, `deno`, `bun`, `perl`, `ruby`, `php`, `awk`
(also `gawk`, `mawk`, and `nawk`), `lua`, `luajit`, `pwsh`, `powershell`, `tsx`, `ts-node`, the
package runners `npx`, `pnpx`, and `bunx`, the C shells `tcsh` and `csh`, and a `busybox` or
`toybox` shell applet is unknown to Buckle, a reading limit, until `buckle policy
allow-interpreter <name>` makes that program an ordinary command. A command allow such as
`npx *` is not enough on its own: the floor still asks, and a deny list refuses.

Each name is allowed separately: `python`, `python3`, and `python3.12` are three names, as are
`node` and `nodejs`, and `buckle policy remove-interpreter <name>` takes one back. `script_run`
with the `python` runtime runs `python3`, and with `node` it runs `node`. Version and help calls
stay ordinary, such as `python3 --version`, `python3 -VV`, `perl -V`, `ruby -v`, and `deno -v`.
Where a workspace turns on the [decision AI](judge.md), an optional model check the node runs with
its own keys, a model rates such a call and the code it runs: at the owner's request, or at each call,
running one it rates safe.

A workspace's list is its own where it has one, used alone; else it is the node's
`BUCKLE_ALLOWED_INTERPRETERS` (`buckle settings set allowed-interpreters`), which is empty by
default. Removing a workspace's last entry gives it the node's list again ([Node
defaults](workspaces-03.md#the-policy-lists)). Moving a node from 0.1 copies no list into any
workspace ([the move](workspaces-04.md)).
