---
name: buckle-browser
description: Drive a real browser from a 5straps Buckle node via agent-browser. Use for navigating pages, filling forms, clicking, and screenshots on the Buckle machine.
---

# Buckle browser

Wraps [agent-browser](https://agent-browser.dev). The tool description says which browser this
node runs, and only the node owner chooses it:

- Fresh, the default: each caller/session alias gets a fresh browser. Commands reuse it until
  `close`; the next launch has no cookies or saved authentication.
- A profile folder: every session shares one browser on the owner's folder, as Chrome opens a
  folder in one browser at a time. Logins and cookies outlive `close`, which closes that browser
  for every session.
- The owner's own Chrome, attached: every session shares that one browser, its cookies, and its
  tabs. A session starts on one of the owner's open tabs, so begin with `tab new <url>` to leave
  it alone, and never close a tab you did not open. `close` only disconnects; the browser and its
  logins stay open.

```
buckle browser command open example.com
buckle browser command snapshot -- -i
buckle browser command click @e2
buckle browser command screenshot page.png
```

## First run on a node

The owner installs agent-browser and runs `agent-browser install` outside the agent interface.
The browser tool cannot install browsers, and no call can attach a browser, choose a profile, or
import saved state.

The browser runs headless unless the node sets `BUCKLE_BROWSER_HEADED=true`, and it is held by a
background daemon that outlives each call, so a later command reuses the browser already running.
Close the session to force a fresh launch after changing that setting.

## What the browser may not reach

Navigation is judged like any other network access. `file://` and other non-HTTP schemes are
refused, so the browser cannot be used to read local files around the path rules. A private or
loopback address asks first: relay the `buckle approve <token>` line to the person, who can also
answer in `buckle approvals --watch` on the Buckle machine, then retry. A page named without a scheme is opened and judged as
`https://<page>`, and `localhost:3000` is host `localhost` on port 3000. Most dev servers speak
plain HTTP, so write `http://localhost:3000` for one. `open` takes exactly one page. Only the page
a command names is judged by Buckle's rules, down to its port and path. When an approved list is
set (the node's or the workspace's), Buckle also starts the browser with the hosts both lists
allow as agent-browser's `--allowed-domains`, so clicks, redirects, and page requests to other
hosts are blocked inside the browser. That holds for a fresh browser only: agent-browser refuses
the list with a profile folder or an attached browser, so there only the page a command names is
judged, and every login in that browser is within reach. Use only the logins the task needs. The
containment is by host: for an entry such as `localhost:3000` or `https://app.example.com/admin`,
the port and path hold for the page a command names, but inside the page that host is reachable
on any port and path. When the node and
workspace lists share no host and port, the browser does not start, and the refusal names the
list to change. When the allowed hosts change, the next call relaunches a fresh browser, which
resets open tabs and cookies, and its result carries a `notice` saying so. Without an approved
list, clicks and redirects are not judged.

Paths given to `screenshot`, `pdf`, `upload`, and `download` are judged by the same path rules as
`fs` tools, so writing outside the workspace asks. Name such a path as a positional argument,
which is where the rules look.

Flags are an allowlist: anything Buckle does not know is refused by name, so read the refusal
rather than guessing a second spelling. `--proxy`, `--proxy-bypass`, and `--allowed-domains` are refused
because Buckle owns the network policy. Also refused on purpose are `--profile`, `--executable-path`,
`--args`, `--extension`, `--init-script`, `--config`, `--cdp`, `--auto-connect`, `--provider`,
`--ca-cert`, `--allow-file-access`, and the flags that read or write an unjudged path,
`--screenshot-dir`, `--download-path`, `--params`, and `--payload`. `--session`, `--state`, and
`--restore` are refused by name too: the owner's settings alone choose the browser.

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
task ends. State expires after five idle minutes; close explicitly when running headed. On a
profile folder, `session` names no separate browser, and cookies and logins stay in the folder; on
an attached browser, idle expiry only disconnects.
