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

Reaching a private address on purpose (a dev server, a Tailscale host) needs approval, and
the grant is per host and port.

## Responses

Bodies are capped at 2 MB with `truncated` set when the cap is hit. `web_search` is only
present when a Brave Search key is configured on the node.
