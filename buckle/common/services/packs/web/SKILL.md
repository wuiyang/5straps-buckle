---
name: buckle-web
description: Fetch URLs and search the web from a 5straps Buckle node, with SSRF protection. Use when you need network content retrieved by the Buckle machine rather than your own.
---

# Buckle web

```
buckle web fetch https://example.com/api.json
buckle web search "zod json schema"
```

## Egress is filtered

Requests to private, loopback, link-local, and carrier-grade-NAT addresses are refused by
default. That covers a public hostname that *resolves* into one, and a public URL that
*redirects* into one. Every redirect hop is re-resolved and re-checked.

Without an approved list, reaching a private address on purpose (a dev server, a Tailscale
host) needs approval, and the grant is per host and port. With a list, only what it names is
reached, and a private address only through an entry naming its host exactly; a host a wildcard
covers is refused where it resolves into one.

## Secrets in headers

To send a value from a dotenv file without seeing it, write `{{file:.env.local:API_TOKEN}}` in a header's
value. Buckle asks a person once per file, puts the value in, shows you `[secret:NAME]` where the
response echoes it, and drops the header on a redirect to another origin
([secret references](https://github.com/wuiyang/5straps-buckle/blob/main/docs/user/how-to/secrets.md)).

## Responses

Bodies are capped at 2 MiB, with `truncated` set when the response held more than that.
`web_search` is only present when a Brave Search key is configured on the node.
