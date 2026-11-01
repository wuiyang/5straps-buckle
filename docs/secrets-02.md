# Secret masking

Buckle, the local permission node, never hands the agent the value a
[secret reference](secrets.md) names: it shows `[secret:NAME]` in the value's place. This page
says where and in which forms, how a browser keeps a value after a fill, and what masking cannot
reach.

## Where and in which forms

Buckle shows each value as `[secret:NAME]` wherever text leaves it: the command's output and
errors, the browser's result, a fetch's response headers and body, the audit log, every log line,
every error, and every approval line. It masks the value URL-encoded, JSON-escaped, and as HTML
entities, whichever characters the encoder escapes, in base64 and base64url, wrapped or not, and
inside the base64 of a Basic authorization, when the form is at least 8 characters, and masks a
value split across output chunks or cut where output reached its bound. Values are held in memory
only while the call runs, or for a code mode script, until the script answers.

## After a browser fill

The page still holds a value after a fill, so every later browser call in the workspace is masked
by it too, in any Buckle process and after a restart. Buckle records the file, the NAME, and a
digest of the value, never the value, beside the workspace's browser sessions. Each call reads the
file again and is refused if the file is gone or changed since the fill; put it back, or end the
workspace's browsers with `close`, which runs even then. The hold ends when Buckle closes the
workspace's last browser. An attached Chrome only disconnects at `close` and keeps its pages, so
its hold stays.

## In a code mode script

A [code mode](code-mode.md) script's calls are masked by every value the script's calls resolved,
from the moment each is read until the script answers. A call with no reference of its own is
masked too, so a file a page or a command saved the value to reads as `[secret:NAME]` when a later
call of the same script reads it. The script's replay record keeps each value's file, NAME, and
digest, never the value. A script resumed after an ask reads them again before any call runs. If
one is gone or changed, Buckle refuses the send, naming the file and NAME, and runs nothing; put
the file back, or change the script to run it from its start.

## Limits

Masking works on text. These stay unmasked:

- The value a command or a page writes to a file. A direct call or another script that reads the
  file back sees it; a later call of the same script sees the label.
- The value sent over the network by a route Buckle does not see, such as a child the sandbox lets
  reach the network.
- Output that transforms the value another way, such as reversing it.
- A screenshot or PDF of a page showing the value.
- The program's memory and argument list, which other processes on the machine can read while it runs.
- A filled page another workspace reaches through a shared profile folder or attached Chrome.
