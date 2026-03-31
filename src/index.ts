interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Domains MCP — Domainsdb.info API (free, no auth)
 *
 * Tools:
 * - search_domains: search for registered domains matching a name/keyword
 */


const BASE_URL = 'https://api.domainsdb.info/v1';

const tools: McpToolExport['tools'] = [
  {
    name: 'search_domains',
    description:
      'Search for registered domains matching a keyword or partial name. Optionally filter by TLD zone (e.g., "com", "net", "org") and limit the number of results. Returns domain names with registration dates.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Domain name or keyword to search for (e.g., "google", "weather", "shop")',
        },
        zone: {
          type: 'string',
          description: 'TLD zone to search within (e.g., "com", "net", "org", "io"). Omit to search all zones.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (1-100, default 10)',
        },
      },
      required: ['domain'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_domains':
      return searchDomains(
        args.domain as string,
        args.zone as string | undefined,
        args.limit as number | undefined,
      );
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function searchDomains(domain: string, zone?: string, limit?: number) {
  const pageSize = Math.min(100, Math.max(1, limit ?? 10));

  const params = new URLSearchParams({
    domain,
    limit: String(pageSize),
  });
  if (zone) params.set('zone', zone);

  const res = await fetch(`${BASE_URL}/domains/search?${params}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Domainsdb API error: ${res.status}`);

  const data = (await res.json()) as {
    domains: {
      domain: string;
      create_date: string;
      update_date: string;
      country: string;
      isDead: string;
      A: string[] | null;
      NS: string[] | null;
      CNAME: string[] | null;
      MX: { exchange: string; priority: number }[] | null;
    }[];
    total: number;
    time: string;
    next_page: string | null;
  };

  return {
    query: domain,
    zone: zone ?? 'all',
    total_available: data.total,
    returned: data.domains.length,
    domains: data.domains.map((d) => ({
      domain: d.domain,
      created: d.create_date,
      updated: d.update_date,
      country: d.country || null,
      is_dead: d.isDead === 'True',
      a_records: d.A ?? [],
      ns_records: d.NS ?? [],
      mx_records: d.MX ? d.MX.map((mx) => `${mx.exchange} (priority ${mx.priority})`) : [],
    })),
  };
}

export default { tools, callTool } satisfies McpToolExport;
