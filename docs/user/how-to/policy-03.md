# Policy: what stays unread

What Buckle, the approval and sandbox runtime on this machine, leaves unread in a command call,
and the limits it does not mark. It follows [What Buckle reads](policy-02.md). An unread call is
refused under any deny glob and asked about at the
[destructive floor](approvals.md#the-destructive-floor) with none.

## Expansions

A word an expansion supplies (`$x`, `"$(...)"`, a glob such as `*.log`, a brace expansion, or a
word starting with an unquoted `=`, which zsh turns into the path of the command it names, `=rm`)
exists only once the shell runs.

- As a command word it leaves the call unread (expansion): `$cmd push origin main`,
  `x=git; $x push`, `{git,true} push`, `=git push` in any shell's text, and a lone `~`, `~-`,
  `~+`, or `~user`, which HOME, OLDPWD, PWD, or a home supplies whole
  (`HOME=/usr/bin/git; ~ push`). A tilde path keeps the name it types (`~/bin/tool`).
- Among the words a wrapper, `xargs`, `find`, `ssh`, `su`, or a shell reads before the command it
  runs, it may become an option, an option's value, or several words, and so move that command
  (`v="1 git"; timeout $v push`). The call is unread, ordinary shapes included: `timeout $T cmd`,
  `timeout "$T" cmd`, `env FOO=$BAR cmd`, `sudo -u $USER cmd`, `nice -n $N cmd`,
  `ssh "$HOST" cmd`, `find $DIR -name x`, `find . -name *.log`, `xargs -P $(nproc) cmd`,
  `flock "$LOCK" cmd`, `bash "$script" "$@"`, and `su "$user" -c cmd`. So is a value attached to
  a short option (`nice -n"$N" cmd`): left empty, it leaves `-n` to take the next word.
- These stay read, since the expansion cannot move the command: a quoted value after an option
  that takes one (`sudo -u "$USER" cmd`, `nice -n "$N" cmd`) or after a long option's `=`
  (`timeout --signal="$s"`), a quoted assignment value
  (`env FOO="$BAR" cmd`), an assignment before the command (`FOO=$BAR cmd`), a quoted `find`
  primary value (`find . -name "$p"`), an operand with typed text first (`ssh deploy@"$host" cmd`),
  and a shell's quoted script with nothing after it (`bash "$script"`). Write the value out, or
  quote it after an option that takes one, to keep a call read.
- In a later word, an argument, an expansion leaves the call read, and a deny glob meets the words
  as typed. `git push origin $x` meets `git push *` and is refused, but `git $x origin main` does
  not, and runs whatever `$x` holds. Deny the program itself (`git`), or use an allow list, which
  admits only the lines its globs spell out.
- `trap`, `alias`, or `mapfile -C` text an expansion supplies is unread too (`trap "$x" EXIT`), and
  so is a call that defines an alias and hands the same shell text it parses later (`eval`, a
  `trap` action, or a sourced input), where the alias may reach.

## Script files

A script file run directly runs code Buckle does not read, so the
[destructive floor](approvals.md#the-destructive-floor) asks about it, as about an unknown
interpreter (script file):

- a shell given a script: `bash deploy.sh`, `sh -e x.sh`, `zsh x.sh`;
- `source ./env.sh` and `. venv/bin/activate`;
- a command word written as a path, which runs the file at that path whatever its name says:
  `./deploy.sh`, `bin/tool`, `/tmp/x`, and `/usr/bin/git`. Write the bare name (`git`) to have it
  judged by its words.

It asks under a deny list too, rather than being refused, and offers `once` and `session`. An allow
glob that spells the path (`buckle policy allow-command './deploy.sh *'`) runs that file without
asking; one naming a shell (`bash *`) does not. The [dangerously-allow switch](approvals-04.md)
answers it only at `on`, and the [decision AI](judge.md) may where it is set to: it is shown the
script that `sh`, `bash`, or `dash` runs as the call itself, and leaves any other to a person.

`npm run`, `npm test`, `pnpm dev`, `make`, and other package scripts and task runners are judged by
their own words, so they do not ask, and what they run is not read: a `package.json` or `Makefile`
the agent edits can still run anything, malware included. Where the decision AI rates one, it reads
the command line and the `package.json` script's text, not the files that script runs.

## Scripts as data and startup files

- A shell or `source` given a script file while the call's own text feeds its input (a pipe from a
  command in the call, a heredoc, a here-string, or a process substitution) is unread (script as
  data): in `echo '...' | bash ./run.sh` the file may be a link to that input. With no such feed it
  is a script file: `bash ./run.sh < input.txt`.
- A startup file whose text the call supplies is unread (script as data):
  `BASH_ENV=<(echo ...) bash -c true`, or `bash --rcfile <(...) -i`. A file on disk
  (`BASH_ENV=/etc/profile`) or `/dev/null` leaves the call read, as a script file does.
- A startup file that reaches bash through a program Buckle does not see as a shell is not marked:
  `BASH_ENV=<(echo ...) ./deploy.sh`, where `deploy.sh` has a bash shebang, or
  `BASH_ENV=<(echo ...) make SHELL=/bin/bash`. The call reads as complete, and no rule meets what
  the startup file runs; `./deploy.sh` still asks as a script file, and `make` does not.

## Other programs and run-time text

- A program outside the wrapper list that runs a command, such as `parallel`, is judged by its own
  words only: `parallel git push origin ::: main` does not meet `git push *`, and the floor does
  not read past it. Deny the program itself, or leave it off an allow list.
- Text bash builds and evaluates at run time, which the call does not spell out, is not read:
  `p='$(git'; x="a[$p push origin main)]"; (( x ))` runs a push through arithmetic on a variable's
  text, and so can `PS4` under `set -x`. Text the call spells out is read:
  `x='a[$(git push origin main)]'; (( x ))` meets `git push *`.
