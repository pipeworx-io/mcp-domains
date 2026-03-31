# @pipeworx/mcp-domains

MCP server for domain WHOIS data — availability checks and registration info.

## Tools

| Tool | Description |
|------|-------------|
| `search_domains` | Search for registered domains matching a keyword, with optional TLD filtering |

## Quick Start

Add to your MCP client config:

```json
{
  "mcpServers": {
    "domains": {
      "url": "https://gateway.pipeworx.io/domains/mcp"
    }
  }
}
```

Or run via CLI:

```bash
npx pipeworx use domains
```

## License

MIT
