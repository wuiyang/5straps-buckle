# Known limits

Limits on what Buckle, the approval and sandbox runtime on this machine, reads, hides, or handles, with examples. [What stays unread](policy-03.md) goes deeper on commands,
[part two](known-limits-02.md) the programs it starts itself,
[part three](known-limits-03.md) code mode, the command line, and workspaces,
[part four](known-limits-04.md) mounts, the sandbox layout, the URL list, the browser, and the
forge pack,
[part five](known-limits-05.md) services and the terminal,
[parts six](known-limits-06.md) and [seven](known-limits-07.md) the decision AI,
[part eight](known-limits-08.md) the file tools, and [part nine](known-limits-09.md) read-only
pushes, MCP asks, deletes, and history.

## Reading commands

- A call Buckle cannot read whole is refused under a deny rule, and asked about at the
  [destructive floor](approvals.md#the-destructive-floor) with none, so some ordinary calls are
  refused: under any deny rule, `timeout "$T" make test` and `nice -n"$N" make` are refused.
- A deny rule meets the words as typed: `git $x origin main` does not meet `git push *`, and runs
  whatever `$x` holds. Deny the program itself, or use an allow list.
- A script file on disk, and text bash builds at run time, are not read: `bash deploy.sh` is judged
  by those two words, and `p='$(git'; x="a[$p push origin main)]"; (( x ))` runs a push no rule
  meets.
- A program outside the [wrapper list](policy-02.md#what-buckle-reads), such as `parallel`, is
  judged by its own words: `parallel git push origin ::: main` does not meet `git push *`.
- A startup file that reaches bash through a shebang script or `make` is not marked:
  `BASH_ENV=<(echo ...) ./deploy.sh` reads as complete, and no rule meets what the file runs.
- `npm exec`, `pnpm dlx`, and `yarn dlx` run a package's code as `npx` does, but are ordinary
  commands, judged by their own words, not interpreters: `npm exec some-tool` meets only a rule
  that names `npm`. `npx`, `pnpx`, and `bunx` are interpreters ([policy](policy-02.md#interpreters)).
- Interpreter names match exactly: `buckle policy allow-interpreter python3` does not allow
  `python3.12`.
- A word ending in a parenthesised list holding an `e`, a `+`, a `$`, or a backtick leaves the
  call unread (glob qualifier) in any shell's text, since zsh may run code from it once for each
  file it matches (`echo *(e:'...':)`, or `echo *($v)` once zsh fills in `$v`). An extended glob of
  that shape is unread too, so under a deny rule `ls @(one|three)` is refused.
- Text where zsh may run code a parameter's value holds is unread too (glob substitution): `${~v}`,
  `$~v`, a `setopt`, `set -o`, or `zsh -o` naming `globsubst`, and any `emulate` read the value as a
  pattern whose qualifiers run code, and `${(e)v}` runs its substitutions. Under a deny rule
  `emulate -L zsh` is refused.
- zsh is read as zsh under its other names too: `rzsh`, `zsh5`, `zsh-static`, `zsh-5.9`, and
  `zsh.old`. A shell under a name Buckle does not list, such as `rksh` or `ksh93`, is judged by its
  own words: `rksh -c 'git push'` does not meet `git push *`.

## Credential hiding

What an approver sees hides credentials on a best-effort basis. The hiding is display only: a
decision binds the whole call, whatever the display hides.

- A key matches when its name contains `password`, `secret`, or `token` anywhere, so a setting
  such as `TOKENIZERS_PARALLELISM=false` reads `[redacted]` too.
- A value under such a key, or a URL's password, shows as written when it holds a blank or a
  shell character: `--password='<two words>'` and `postgres://app:<pass;word>@db/app` both show.
- In JSON text, such as a file being written, a list or map under such a key shows its items:
  `{"api_tokens": ["<value>"]}` shows the value.
- A JSON document inside a command word is not read: `curl -d '{"password":"<value>"}' <url>`
  shows the value, in the subject too.
- A refused shell wrapper repeats the typed words in the rule it names:
  `env DATABASE_URL=postgres://app:<password>@db/app bash -c ls` names a rule holding the
  password.
- In tool arguments, a value under such a key is hidden even when it is a script: an `env` entry
  `X_SECRET_SETUP` holding `touch x; rm -rf build` reads `[redacted]`, so the approver cannot see
  what it runs.
- An ask keeps its call's arguments with such values hidden, so `buckle approvals judge` cannot
  rebuild a call holding one (a URL's password, `--token=<value>`) and rates nothing, saying so;
  the [decision AI](judge.md) in automated mode rates the call as sent.

## Paths and Windows

- On Linux and macOS, a tool path holding a backslash or starting with a drive letter is refused,
  as Buckle reads them as a separator and a Windows drive: `notes\draft.md`, `c:/notes`, and
  `./C:/notes`, which folds to `C:/notes`. So is a folder at the filesystem root named like a
  drive, `/c:`, reached by a climb or a link.
- On Windows, a name ending in a dot or a space, such as `notes.`, is refused: programs Buckle
  starts read it as another name.
- An entry named either way is left out of listings, searches, and history, and the file tools
  cannot read or write it. History logs it once, and lists a change to it as not restorable. The
  shell sandbox and the staged editor refuse to run while it exists.
- On Windows, a path holding a colon other than a leading drive's, as in `C:\`, is refused:
  Windows reads `notes.txt:payload` and `.env::$DATA` as hidden streams of the file, and
  `D:notes` from that drive's working directory.
- Windows has no open that refuses a symbolic link, so there Buckle checks the path for a link or
  junction just before opening it, opens it without creating or truncating it, compares the file
  it opened with the one it checked, and checks again before truncating. A name that
  was absent at the check is created only while still absent, and an open that creates nothing
  never uses an entry that appeared after the check.
- Two gaps remain. On Windows and macOS, Buckle checks each folder above a file, then opens that
  folder by its path, so a folder swapped for a link in between is followed. On a Windows volume
  without file IDs, the file opened cannot be compared with the one checked, so a file swapped
  for a link before the open, and back before the second check, is followed.
- On Windows, a workspace or state directory on a network share, such as
  `\\server\share\project`, or on a mapped drive, is refused: use a folder on a local drive.
- On Windows, a whole drive such as `D:\`, or a link to one, cannot be the workspace root, a
  scratch root, the state directory, or the client directory: `buckle init` run in `D:\`
  refuses.
