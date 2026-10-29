# mcp-domains

Domains MCP — domain registration lookup + availability search over live RDAP (ICANN standard, keyless). We own this end-to-end — no dependency on gated third-party domain APIs. Availability queries the AUTHORITATIVE registry RDAP server per TLD (resolved via the IANA bootstrap), not the flaky rdap.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

| Tool | Description |
|------|-------------|
| `domain_lookup` | Get full registration details for a domain. Returns registrar, registrant, registration/expiration dates, nameservers, DNSSEC status, and domain status flags. Works for any TLD. |
| `domain_status` | Quick check if a domain is registered or available. Returns registration status and expiration date if registered. |
| `check_availability` | Check whether a name is available to register across MULTIPLE TLDs at once — the domain-hunting tool. Pass a base name ("acme") and get .com/.io/.ai/.co/.net/.org/.app/.dev checked in one call (or pass your own tlds list). For each: available true/false (+ expiration if taken). Use for "is X available", "find an open domain for my project", "which TLDs is X free on". Single-domain detail is domain_status; this is the bulk/brainstorm version. |
| `find_available_domains` | Search for AVAILABLE domain names to register from a keyword — the domain name search / brainstorming tool. Pass a keyword ("acme") and get back which domains are actually free to register: the exact name across .com/.io/.ai/.co/.app/.dev, plus creative variations (getacme.com, acmehq.com, tryacme.io, acmeapp.com, …). Use for "find me an available domain for X", "domain name ideas for my startup", "is there an open domain for X", "suggest domain names". Returns available domains ranked (exact match + .com first). Availability is a live registry (RDAP) signal, keyless. For a single specific domain use domain_status; to check one name across TLDs without variations use check_availability. |
| `certificate_search` | Find the SSL/TLS certificates issued for a domain from public Certificate Transparency logs (Cert Spotter). PREFER OVER WEB SEARCH for "what certificates does X have", "find subdomains of X", "when does X's TLS cert expire", "which CA issued X's cert". With include_subdomains it also ENUMERATES SUBDOMAINS seen in CT logs (asset/attack-surface discovery). Returns each cert's DNS names, issuing CA, validity window, and revocation status, plus a deduplicated list of all discovered hostnames. Keyless. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "domains": {
      "url": "https://gateway.pipeworx.io/domains/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/domains/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/domain_lookup \
  -H 'Content-Type: application/json' \
  -d '{"domain":"google.com"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/domain_lookup`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-domains` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/domains/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "domains": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-domains"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Domains data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
