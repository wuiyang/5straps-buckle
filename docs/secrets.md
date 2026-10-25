# Secret references

Some calls need a value that lives in a dotenv file, such as an API token for a header or a password
for a login form. A secret reference lets the agent name the value without holding it. Buckle, the
local permission node, reads the file as the call starts, puts the value where the reference stands,
and shows the agent `[secret:NAME]` wherever the value would come back. It never reaches the agent's
context, a tool result, a log, or an approval line.

## Writing one

```
buckle shell exec -- deploy-tool --token '{{file:.env.local:DEPLOY_TOKEN}}'
buckle browser command fill @e5 '{{file:.env.local:LOGIN_PASSWORD}}'
buckle web fetch https://api.example.com/me --headers '{"Authorization":"Bearer {{file:.env.local:API_TOKEN}}"}'
```

A reference is `{{file:<path>:NAME}}`, in lower case, with no blanks. The path is relative to the
workspace folder, with no leading `/`, no `..` segment, no drive letter, and no backslash. Under a
[mount](mounts.md), a path beneath the mount's target names the mount's file. `NAME` is letters,
digits, and `_`, and does not start with a digit.

Buckle reads references in three places and no others:

| Tool | Where the reference goes |
|---|---|
| `shell_exec`, and `script_run` with the `bash` runtime | a program's argument, or the Bash body |
| `browser_command` | the text of `fill` or `type`, the second positional |
| `web_fetch` | a header's value |

Anywhere else, Buckle refuses the call before judging it, with "references are read in shell words,
browser fill values, and web_fetch headers only" and where the reference stood. That covers the
program a command runs, a variable, a working directory, a file write, a URL, a request body, a
header name, a browser selector, a Node or Python script body, and a `code_run` script. So does a
command that starts an interpreter, such as `python3 -c`, whose code Buckle does not read. A call
makes at most 64 references to at most 16 files.

In text a shell parses again, such as a `-c` body or a Bash script, write the reference inside
quotes and never after `$` or a backslash. Buckle swaps in a stand-in value holding a blank, and
refuses the call if the reading changes.

Template braces such as `{{ name }}` are plain text. Other reference shapes are refused, naming the
form: `{{env:API_TOKEN}}` names no source, and a capital letter, a blank, or an unknown scheme fail.

## The file

The file must resolve, links followed, to a regular file inside the workspace folder or the source
of a mount the owner declared. Buckle refuses a missing file, a folder, a file over 1 MiB, one that
is not UTF-8, a file swapped since the call was judged, and a NAME the file does not define or
defines on a line it cannot read. A refusal names the file and the NAME, never a value.

The syntax is `NAME=value`, with an optional `export` and `#` comments. A double quoted value takes
the escapes `\n`, `\r`, `\t`, `\\`, and `\"`, a single quoted one is taken as written, and either may
span lines. An unquoted value ends at a `#` after a blank, and a later line wins. Nothing is
interpolated, so `${OTHER}` is that text.

## The ask

The first use of a file in a workspace asks a person once, under the credential-file rule. The ask
shows the file as written and the NAMEs, never values, and the approval line reads "secrets
API_TOKEN from .env.local". The person may allow it once, for the session, or always, remembered per
workspace and file like other grants. With `BUCKLE_STRICT_WRITES=true`, the answer lasts a session
at most. A grant to read the file into the agent's view does not cover its use by a reference, nor
the other way round.

The setting `secrets.files` lists files that need no ask, and `secrets.enabled` off refuses a
reference where it is read, both in the [settings table](workspaces-02.md#settings). The
dangerously-allow switch never answers this ask. Buckle's own state, a file the owner denied, and a
path a filesystem rule denies are refused.

## What the rules see

The rules, the [destructive floor](approvals.md#the-destructive-floor), and the [decision AI](judge.md)
judge the call as written, references included. Buckle puts the values in afterward, into the program's argument list and never its
environment, just before the browser fills or the request goes out. It reads a shell call again with
the values in and runs nothing if the reading differs, as a value holding `;` or a newline would
cause.

A value must hold at least 8 characters, or Buckle refuses with "too short to mask". In shell text
it holds no quote, backslash, `$`, backtick, `!`, or control character. A value starting with `-` is
refused in shell text, at the start of an argument, and as fill text, where a program would read it
as an option. In a header it holds no line break.

## Masking

Buckle shows each value as `[secret:NAME]` wherever text leaves it: the command's output and
errors, the browser's result, a fetch's response headers and body, the audit log, every log line,
every error, and every approval line. It masks the value URL-encoded, JSON-escaped, and as HTML
entities, whichever characters the encoder escapes, in base64 and base64url, and inside the base64
of a Basic authorization, when the form is at least 8 characters, and masks a value split across
output chunks or cut where output reached its bound. Values are held in memory only while the call runs.

After a fill, every later browser call in the workspace is masked by the value too, since the page
still holds it. Each call reads the file again and is refused if the file is gone or changed since
the fill; put it back, or close the browser and restart Buckle. `web_fetch` drops a header carrying
a value when a redirect leaves the origin.

## Limits

Masking works on text. These stay unmasked:

- A command that writes the value to a file, or sends it over the network by a route Buckle does not
  see, such as a child the sandbox lets reach the network.
- Output that transforms the value another way, such as reversing it.
- A screenshot or PDF of a page showing the value.
- The program's memory and argument list, which other processes on the machine can read while it runs.

## Platform values

`{{env:<platform>:NAME}}` is reserved for a value a platform holds, such as Rings, the agent control
plane. Until it ships, Buckle refuses every platform reference, such as `{{env:rings:API_TOKEN}}`, with
"platform references arrive with Rings", and passes none through as text.
