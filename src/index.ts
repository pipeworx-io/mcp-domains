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
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Domains MCP — RDAP domain lookup (ICANN standard, free, no auth)
 *
 * Tools:
 * - domain_lookup: Get registration details for any domain — registrar, status, dates, nameservers
 * - domain_status: Quick check if a domain is registered and its expiration date
 */


const RDAP_BASE = 'https://rdap.org';

interface RdapEntity {
  roles?: string[];
  vcardArray?: [string, [string, Record<string, string>, string, string][]];
  entities?: RdapEntity[];
}

interface RdapEvent {
  eventAction: string;
  eventDate: string;
}

interface RdapNameserver {
  ldhName?: string;
}

interface RdapResponse {
  ldhName?: string;
  unicodeName?: string;
  handle?: string;
  status?: string[];
  events?: RdapEvent[];
  entities?: RdapEntity[];
  nameservers?: RdapNameserver[];
  secureDNS?: { delegationSigned?: boolean };
}

function extractName(entity: RdapEntity): string | null {
  const vcard = entity.vcardArray;
  if (!vcard || !vcard[1]) return null;
  const fn = vcard[1].find((entry) => entry[0] === 'fn');
  return fn ? fn[3] : null;
}

function extractOrg(entity: RdapEntity): string | null {
  const vcard = entity.vcardArray;
  if (!vcard || !vcard[1]) return null;
  const org = vcard[1].find((entry) => entry[0] === 'org');
  return org ? org[3] : null;
}

async function domainLookup(domain: string) {
  const res = await fetch(`${RDAP_BASE}/domain/${encodeURIComponent(domain.toLowerCase())}`, {
    headers: { Accept: 'application/rdap+json, application/json', 'User-Agent': 'Pipeworx/1.0 (pipeworx.io)' },
    redirect: 'follow',
  });
  if (res.status === 404) return { domain, registered: false, error: 'Domain not found in RDAP' };
  if (!res.ok) throw new Error(`RDAP error (${res.status})`);

  const data = await res.json() as RdapResponse;

  const events: Record<string, string> = {};
  for (const e of data.events ?? []) {
    events[e.eventAction] = e.eventDate;
  }

  const registrar = (data.entities ?? []).find((e) => e.roles?.includes('registrar'));
  const registrant = (data.entities ?? []).find((e) => e.roles?.includes('registrant'));
  const nestedRegistrant = registrar?.entities?.find((e) => e.roles?.includes('registrant'));

  return {
    domain: data.ldhName ?? domain,
    unicode_name: data.unicodeName ?? null,
    registered: true,
    status: data.status ?? [],
    registrar: extractName(registrar ?? {}) ?? extractOrg(registrar ?? {}) ?? null,
    registrant: extractName(registrant ?? nestedRegistrant ?? {}) ?? extractOrg(registrant ?? nestedRegistrant ?? {}) ?? null,
    registration_date: events.registration ?? null,
    expiration_date: events.expiration ?? null,
    last_changed: events['last changed'] ?? events['last update of RDAP database'] ?? null,
    nameservers: (data.nameservers ?? []).map((ns) => ns.ldhName?.toLowerCase()).filter(Boolean),
    dnssec: data.secureDNS?.delegationSigned ?? false,
  };
}

async function domainStatus(domain: string) {
  const res = await fetch(`${RDAP_BASE}/domain/${encodeURIComponent(domain.toLowerCase())}`, {
    headers: { Accept: 'application/rdap+json, application/json', 'User-Agent': 'Pipeworx/1.0 (pipeworx.io)' },
    redirect: 'follow',
  });

  if (res.status === 404) return { domain, registered: false, available: true };
  if (!res.ok) throw new Error(`RDAP error (${res.status})`);

  const data = await res.json() as RdapResponse;
  const events: Record<string, string> = {};
  for (const e of data.events ?? []) {
    events[e.eventAction] = e.eventDate;
  }

  return {
    domain: data.ldhName ?? domain,
    registered: true,
    available: false,
    expiration_date: events.expiration ?? null,
    status: data.status ?? [],
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'domain_lookup',
    description:
      'Get full registration details for a domain. Returns registrar, registrant, registration/expiration dates, nameservers, DNSSEC status, and domain status flags. Works for any TLD.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        domain: { type: 'string', description: 'Domain name to look up (e.g., "google.com", "bbc.co.uk")' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'domain_status',
    description:
      'Quick check if a domain is registered or available. Returns registration status and expiration date if registered.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        domain: { type: 'string', description: 'Domain name to check (e.g., "example.com")' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'check_availability',
    description:
      'Check whether a name is available to register across MULTIPLE TLDs at once — the domain-hunting tool. Pass a base name ("acme") and get .com/.io/.ai/.co/.net/.org/.app/.dev checked in one call (or pass your own tlds list). For each: available true/false (+ expiration if taken). Use for "is X available", "find an open domain for my project", "which TLDs is X free on". Single-domain detail is domain_status; this is the bulk/brainstorm version.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Base name to check, e.g. "acme" (a full "acme.com" is also accepted — the label before the first dot is used).' },
        tlds: {
          type: 'array',
          items: { type: 'string' },
          description: 'TLDs to check (without the dot), e.g. ["com","io","ai"]. Default: com, io, ai, co, net, org, app, dev. Max 15.',
        },
      },
      required: ['name'],
    },
  },
];

const DEFAULT_TLDS = ['com', 'io', 'ai', 'co', 'net', 'org', 'app', 'dev'];

async function checkAvailability(name: string, tldsArg?: unknown) {
  const label = String(name ?? '').trim().toLowerCase().split('.')[0].replace(/[^a-z0-9-]/g, '');
  if (!label) throw new Error('Required argument "name" is missing or invalid (e.g., "acme").');
  const tlds = (Array.isArray(tldsArg) && tldsArg.length
    ? tldsArg.map((t) => String(t).trim().toLowerCase().replace(/^\./, ''))
    : DEFAULT_TLDS
  ).filter(Boolean).slice(0, 15);

  const results = await Promise.all(
    tlds.map(async (tld) => {
      const domain = `${label}.${tld}`;
      try {
        const res = await fetch(`${RDAP_BASE}/domain/${encodeURIComponent(domain)}`, {
          headers: { Accept: 'application/rdap+json, application/json', 'User-Agent': 'Pipeworx/1.0 (pipeworx.io)' },
          redirect: 'follow',
        });
        if (res.status === 404) return { domain, available: true };
        if (!res.ok) return { domain, available: null, note: `RDAP ${res.status} (TLD may not support RDAP)` };
        const data = (await res.json()) as RdapResponse;
        const exp = (data.events ?? []).find((e) => e.eventAction === 'expiration')?.eventDate ?? null;
        return { domain, available: false, expiration_date: exp };
      } catch {
        return { domain, available: null, note: 'lookup failed (TLD may not support RDAP)' };
      }
    }),
  );

  return {
    name: label,
    checked: results.length,
    available_count: results.filter((r) => r.available === true).length,
    results,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'domain_lookup':
      return domainLookup(args.domain as string);
    case 'domain_status':
      return domainStatus(args.domain as string);
    case 'check_availability':
      return checkAvailability(args.name as string, args.tlds);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
