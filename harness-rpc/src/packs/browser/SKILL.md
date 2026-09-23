---
name: buckle-browser
description: Drive a real browser from a 5straps Buckle node via agent-browser. Use for navigating pages, filling forms, clicking, and screenshots on the Buckle machine.
---

# Buckle browser

Wraps [agent-browser](https://agent-browser.dev). Each caller/session alias gets a fresh browser.
Commands reuse it until `close`; the next launch has no cookies or saved authentication.

```
buckle browser command open example.com
buckle browser command snapshot -- -i
buckle browser command click @e2
buckle browser command screenshot page.png
```

## First run on a node

The owner installs agent-browser and runs `agent-browser install` outside the agent interface.
The browser tool cannot install browsers, attach an existing browser or import saved state.

The browser runs headless unless the node sets `BUCKLE_BROWSER_HEADED=true`, and it is held by a
background daemon that outlives each call, so a later command reuses the browser already running.
Close the session to force a fresh launch after changing that setting.

## What the browser may not reach

Navigation is judged like any other network access. `file://` and other non-HTTP schemes are
refused, so the browser cannot be used to read local files around the path rules. A private or
loopback address asks first. A page named without a scheme is opened and judged as
`https://<page>`, and `localhost:3000` is host `localhost` on port 3000. Only the page a command
names is judged: links clicked and redirects inside the browser are not.

Paths given to `screenshot`, `pdf`, `upload` and `download` are judged by the same path rules as
`fs` tools, so writing outside the workspace asks. Name such a path as a positional argument,
which is where the rules look.

Flags are an allowlist: anything Buckle does not know is refused by name, so read the refusal
rather than guessing a second spelling. Refused on purpose are `--profile`, `--executable-path`,
`--args`, `--extension`, `--init-script`, `--config`, `--cdp`, `--auto-connect`, `--provider`,
`--ca-cert`, `--allow-file-access`, and the flags that read or write an unjudged path,
`--screenshot-dir`, `--download-path`, `--params` and `--payload`.

The runtime ignores ambient `AGENT_BROWSER_*` settings and uses an explicit empty configuration.
Browser file operations require explicit paths; screenshots and downloads are checkpointed.

## The loop

1. `open <url>` to navigate.
2. `snapshot -i` for the accessibility tree with element refs, interactive elements only.
3. Act on refs from that snapshot: `click @e2`, `fill @e5 "text"`, `press Enter`.
4. Re-snapshot after anything that changes the page; refs are invalidated by navigation.

Never guess a ref. Take a snapshot and use what it returns.

## Sessions

Pass `session` to name a browser within the current caller. Buckle scopes the alias to the supplied caller and optional stage ID. A new stage starts
a separate browser; labels group work and are not authentication identities. Close each browser when the
task ends. State expires after five idle minutes; close explicitly when running headed.
