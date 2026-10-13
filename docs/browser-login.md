# Using your own browser

Buckle, the approval and sandbox runtime on your machine, gives every agent session a fresh
browser by default: no cookies, no saved logins, and nothing kept after `close`. Three node
settings let the owner choose otherwise: a profile folder that keeps logins, your own Chrome
attached over its DevTools port, or extra Chromium arguments. Only the environment file sets them,
and nothing an agent sends can select one. Restart `buckle serve` or `buckle mcp` after a change.

## Logging in without a setting

Often no setting is needed. With `BUCKLE_BROWSER_HEADED=true` the browser opens a visible window,
and a person logs in there by hand. The agent never sees the credentials, only the pages after.
That session lives until `close`, 5 idle minutes, or a change to the approved hosts, which
relaunches the browser.

## The settings

| Setting | Value | What Buckle passes to `agent-browser` |
|---|---|---|
| `BUCKLE_BROWSER_PROFILE` | an absolute folder that already exists | `--profile <folder>`, so cookies, storage, and cache survive `close`, idle shutdown, and node restarts |
| `BUCKLE_BROWSER_CDP` | a DevTools port such as `9222`, or a `ws://` or `http://` URL | `--cdp <value>` on every command, which then runs in your Chrome |
| `BUCKLE_BROWSER_ARGS` | Chromium arguments, separated by commas or new lines | `--args <value>` for a browser Buckle launches |

`BUCKLE_BROWSER_CDP` stands alone. An attached browser keeps the profile, arguments, and window
you started it with, so Buckle refuses to start when it is set beside `BUCKLE_BROWSER_PROFILE`,
`BUCKLE_BROWSER_ARGS`, or `BUCKLE_BROWSER_HEADED=true`, and the message names them.

The profile folder is judged by the rule that judges `BUCKLE_AGENT_BROWSER_COMMAND`: Buckle does
not load from where an agent can write. A folder inside or around a workspace, a scratch root, or
the node's state directory, or one reached through a link there, is refused, and so is a folder
that does not exist yet. The browser pack is then withheld, and its reason names the setting,
never the path. `buckle manifest` shows it.

For example, to pass the argument most often asked for:

```bash
BUCKLE_BROWSER_ARGS=--disable-blink-features=AutomationControlled
```

`agent-browser` splits the value at commas, so one argument cannot itself hold a comma.
`--user-data-dir` and `--profile-directory` are refused in it: name a profile folder with
`BUCKLE_BROWSER_PROFILE`, where its rule applies. Whatever is set, a site decides for itself what
it accepts, and it may still refuse a browser it takes for an automated one.

## Attaching your own Chrome

Start Chrome with a DevTools port and a profile folder of its own:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/buckle-chrome"
```

Since Chrome 136, Chrome ignores the port on its default profile, so keep a second profile folder
for Buckle, sign in there to the sites the agent needs, and leave your everyday profile out of it.
Then set `BUCKLE_BROWSER_CDP=9222` in `buckle.env` and restart.

Buckle never closes that browser. `close` only disconnects, and so does an idle session after 5
minutes or Buckle's own shutdown: your browser, its tabs, and its logins stay open. Every agent
session works in that one browser: sessions share its cookies, and the agent can see and use every
tab open there.

The DevTools port answers anything on this machine that reaches it. Shell commands have no
network unless `BUCKLE_SHELL_NETWORK=true`; with it on, a command could drive the browser around
Buckle's rules.

## What containment is lost, and what is still judged

With a fresh browser and an approved list, Buckle passes the list's hosts as `agent-browser`'s
`--allowed-domains`, so clicks, redirects, and page requests stay on them inside the browser.
`agent-browser` refuses that flag with a profile folder and with an attached browser, because
Chrome can open or restore pages before the containment is installed. In those modes Buckle passes
no list, logs one warning naming the setting when the pack starts, and says so in the tool
description and the agent's skill.

Still judged in every mode:

- the page each command names, by the network rules down to its port and path;
- every file a screenshot, PDF, download, or upload names, by the path rules;
- every flag, refused by name unless Buckle knows it. `--cdp`, `--auto-connect`, `--profile`,
  `--args`, `--state`, `--restore`, and `--session` stay refused to the agent.

No longer judged in those modes: where a page goes after it loads, and what it requests. Every
login kept in that profile folder or that browser is within the agent's reach, which is why it
should hold only the logins the agent's work needs.

Chrome lets one running browser use a profile folder at a time, so close one session before
another starts. With a profile folder no host list is passed, so a changed approved list
relaunches nothing.

## Checking the mode

The setup face's `/setup/status` reports `browser.mode` as `fresh`, `profile`, or `attached`, and
`browser.setting` as the setting that chose it, never its value.
