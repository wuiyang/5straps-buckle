# Known limits

What Buckle, the approval and sandbox runtime on this machine, does not yet read, hide, or
handle, each with an example. [What stays unread](policy-03.md) covers reading commands in more
depth, and [Programs Buckle runs](known-limits-02.md) the programs it starts itself.

## Reading commands

- A call Buckle cannot read whole is refused under a deny rule, and asked about at the
  [destructive floor](approvals.md#the-destructive-floor) with none, so some ordinary calls are
  refused: under any deny rule, `timeout "$T" make test` and `nice -n"$N" make` are refused.
- A deny rule meets the words as typed: `git $x origin main` does not meet `git push *`, and runs
  whatever `$x` holds. Deny the program itself, or use an allow list.
- A script file on disk, and text bash builds at run time, are not read: `bash deploy.sh` is judged
  by those two words, and `p='$(git'; x="a[$p push origin main)]"; (( x ))` runs a push no rule
  meets.
- A program outside the [wrapper list](policy-02.md#what-buckle-reads), such as `watch` or
  `parallel`, is judged by its own words: `watch git push origin main` does not meet
  `git push *`.
- A startup file that reaches bash through a shebang script or `make` is not marked:
  `BASH_ENV=<(echo ...) ./deploy.sh` reads as complete, and no rule meets what the file runs.
- `npx`, `pnpx`, and `bunx` are ordinary commands, judged by their own words, not interpreters:
  `npx some-tool` meets only a rule that names `npx`.
- Interpreter names match exactly: `buckle policy allow-interpreter python3` does not allow
  `python3.12`.

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
  scratch root, the state directory, or the client directory. Buckle started in `D:\` without
  `BUCKLE_WORKSPACE_ROOT` refuses to start.

## The command line

- `buckle serve --help` and `buckle mcp --help` start the service rather than print help.
  `buckle --help` lists the commands without reading any configuration.
