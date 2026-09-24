# mcp-domains

Domains MCP — domain registration lookup + availability search over live

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

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

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/domain_lookup \
  -H 'Content-Type: application/json' \
  -d '{"domain":"google.com"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/domain_lookup`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

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

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-domains
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

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
