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
only while the call runs.

## After a browser fill

The page still holds a value after a fill, so every later browser call in the workspace is masked
by it too, in any Buckle process and after a restart. Buckle records the file, the NAME, and a
digest of the value, never the value, beside the workspace's browser sessions. Each call reads the
file again and is refused if the file is gone or changed since the fill; put it back, or end the
workspace's browsers with `close`, which runs even then. The hold ends when Buckle closes the
workspace's last browser. An attached Chrome only disconnects at `close` and keeps its pages, so
its hold stays.

## Limits

Masking works on text. These stay unmasked:

- A command that writes the value to a file, or sends it over the network by a route Buckle does not
  see, such as a child the sandbox lets reach the network.
- Output that transforms the value another way, such as reversing it.
- A screenshot or PDF of a page showing the value.
- The program's memory and argument list, which other processes on the machine can read while it runs.
- A filled page another workspace reaches through a shared profile folder or attached Chrome.
