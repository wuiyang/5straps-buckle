---
name: buckle-browser
description: Drive a real browser from a 5straps Buckle node via agent-browser. Use for navigating pages, filling forms, clicking, and screenshots on the Buckle machine.
---

# Buckle browser

Wraps [agent-browser](https://agent-browser.dev). The browser lives on the Buckle node, so
its cookies, logins, and profile stay on that machine. The profile is Buckle's own, one per
workspace, never the profile a person signs into on that machine.

```
buckle browser command open example.com
buckle browser command snapshot -- -i
buckle browser command click @e2
buckle browser command screenshot page.png
```

## First run on a node

The CLI ships without a browser. If every command fails, run `browser command install` once to
download Chrome. `browser command doctor` reports what is missing.

The browser runs headless unless the node sets `BUCKLE_BROWSER_HEADED=true`, and it is held by a
background daemon that outlives each call, so a later command reuses the browser already running.
Close the session to force a fresh launch after changing that setting.

## What the browser may not reach

Navigation is judged like any other network access. `file://` and other non-HTTP schemes are
refused, so the browser cannot be used to read local files around the path rules. A private or
loopback address asks first.

Paths given to `screenshot`, `pdf`, `upload` and `download` are judged by the same path rules as
`fs` tools, so writing outside the workspace asks. Name such a path as a positional argument,
which is where the rules look.

Flags are an allowlist: anything Buckle does not know is refused by name, so read the refusal
rather than guessing a second spelling. Refused on purpose are `--profile`, `--executable-path`,
`--args`, `--extension`, `--init-script`, `--config`, `--cdp`, `--auto-connect`, `--provider`,
`--ca-cert`, `--allow-file-access`, and the flags that read or write an unjudged path,
`--screenshot-dir`, `--download-path`, `--params` and `--payload`.

The node's own `AGENT_BROWSER_*` settings still reach the browser, but `AGENT_BROWSER_PROFILE`
is withheld: nothing in the environment or in a flag can replace the profile Buckle owns.

## The loop

1. `open <url>` to navigate.
2. `snapshot -i` for the accessibility tree with element refs, interactive elements only.
3. Act on refs from that snapshot: `click @e2`, `fill @e5 "text"`, `press Enter`.
4. Re-snapshot after anything that changes the page; refs are invalidated by navigation.

Never guess a ref. Take a snapshot and use what it returns.

## Sessions

Pass `session` to keep isolated browser state across calls. Without it, calls share the
node's default session, so a second task can inherit the first one's logged-in state.
