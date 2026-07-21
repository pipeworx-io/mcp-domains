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
 * Domains MCP — domain registration lookup + availability search over live
 * RDAP (ICANN standard, keyless). We own this end-to-end — no dependency on
 * gated third-party domain APIs. Availability queries the AUTHORITATIVE registry
 * RDAP server per TLD (resolved via the IANA bootstrap), not the flaky rdap.org
 * redirect layer, so 200=registered / 404=available is reliable.
 *
 * Tools:
 * - domain_lookup: full registration details — registrar, status, dates, nameservers
 * - domain_status: quick registered-or-available check for one domain
 * - check_availability: one name across many TLDs
 * - find_available_domains: keyword → available domain-name ideas (domain search)
 * - certificate_search: CT-log certificates + subdomain discovery
 */


const RDAP_BASE = 'https://rdap.org';
const CERTSPOTTER = 'https://api.certspotter.com/v1/issuances';
const IANA_BOOTSTRAP = 'https://data.iana.org/rdap/dns.json';

// TLD → authoritative RDAP base URL, from IANA's bootstrap registry. rdap.org
// is a shared redirect layer that times out / 429s under bulk availability
// checks; querying the authoritative server directly (Verisign for .com/.net,
// etc.) is reliable. Cached in-isolate for 24h. Falls back to rdap.org for any
// TLD the bootstrap doesn't cover.
let bootstrapCache: { map: Map<string, string>; at: number } | null = null;
const BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000;

// Authoritative RDAP servers for popular TLDs the IANA bootstrap omits (notably
// .io). Verified live 2026-07-21 (pipeworx.io→200 registered, unregistered→404).
const RDAP_OVERRIDES: Record<string, string> = {
  io: 'https://rdap.identitydigital.services/rdap/',
};

// Returns the authoritative RDAP base for a TLD and whether it IS authoritative.
// authoritative=false means we only have the shared rdap.org fallback, where a
// 404 does NOT reliably mean "available" (rdap.org 404s TLDs it can't route) —
// so callers must treat a non-authoritative 404 as "unknown", never available.
async function rdapBaseForTld(tld: string): Promise<{ base: string; authoritative: boolean }> {
  const t = tld.toLowerCase();
  if (RDAP_OVERRIDES[t]) return { base: RDAP_OVERRIDES[t], authoritative: true };
  const now = Date.now();
  if (!bootstrapCache || now - bootstrapCache.at > BOOTSTRAP_TTL_MS) {
    try {
      const res = await fetch(IANA_BOOTSTRAP, { headers: { Accept: 'application/json' } });
      const data = (await res.json()) as { services?: [string[], string[]][] };
      const map = new Map<string, string>();
      for (const [tlds, urls] of data.services ?? []) {
        const base = (urls.find((u) => u.startsWith('https://')) ?? urls[0])?.replace(/\/?$/, '/');
        if (base) for (const bt of tlds) map.set(bt.toLowerCase(), base);
      }
      bootstrapCache = { map, at: now };
    } catch {
      if (!bootstrapCache) bootstrapCache = { map: new Map(), at: now };
    }
  }
  const found = bootstrapCache.map.get(t);
  return found ? { base: found, authoritative: true } : { base: `${RDAP_BASE}/`, authoritative: false };
}

// One availability probe against the authoritative RDAP server.
// 200 = registered, 404 = available, anything else (429/timeout/5xx) = unknown.
async function probeAvailability(
  domain: string,
): Promise<{ domain: string; available: boolean | null; expiration_date?: string | null; note?: string }> {
  try {
    const tld = domain.slice(domain.lastIndexOf('.') + 1);
    const { base, authoritative } = await rdapBaseForTld(tld);
    const url = `${base}domain/${encodeURIComponent(domain)}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch(url, {
        signal: ctl.signal,
        headers: { Accept: 'application/rdap+json, application/json', 'User-Agent': 'Pipeworx/1.0 (pipeworx.io)' },
        redirect: 'follow',
      });
      // 200 = registered is always reliable. 404 = available ONLY from the
      // authoritative registry server; via the rdap.org fallback a 404 can just
      // mean "TLD not routable here", so we must not claim availability.
      if (res.status === 200) {
        const data = (await res.json()) as RdapResponse;
        const exp = (data.events ?? []).find((e) => e.eventAction === 'expiration')?.eventDate ?? null;
        return { domain, available: false, expiration_date: exp };
      }
      if (res.status === 404) {
        return authoritative
          ? { domain, available: true }
          : { domain, available: null, note: `no authoritative RDAP for .${tld} — availability unconfirmed` };
      }
      if (res.status === 429) return { domain, available: null, note: 'registry rate-limited — availability unknown, retry shortly' };
      return { domain, available: null, note: `RDAP ${res.status} — availability unknown` };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { domain, available: null, note: 'lookup failed or timed out — availability unknown' };
  }
}

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
  {
    name: 'find_available_domains',
    description:
      'Search for AVAILABLE domain names to register from a keyword — the domain name search / brainstorming tool. Pass a keyword ("acme") and get back which domains are actually free to register: the exact name across .com/.io/.ai/.co/.app/.dev, plus creative variations (getacme.com, acmehq.com, tryacme.io, acmeapp.com, …). Use for "find me an available domain for X", "domain name ideas for my startup", "is there an open domain for X", "suggest domain names". Returns available domains ranked (exact match + .com first). Availability is a live registry (RDAP) signal, keyless. For a single specific domain use domain_status; to check one name across TLDs without variations use check_availability.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        keyword: { type: 'string', description: 'Base keyword or brand name to build domain ideas from, e.g. "acme".' },
        tlds: {
          type: 'array',
          items: { type: 'string' },
          description: 'TLDs to consider (without the dot), e.g. ["com","io","ai"]. Default: com, io, ai, co, app, dev. Max 10.',
        },
        include_variations: { type: 'boolean', description: 'Also try prefix/suffix variations (get-, try-, -app, -hq, …). Default true. Set false for exact-keyword-only across TLDs.' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'certificate_search',
    description:
      "Find the SSL/TLS certificates issued for a domain from public Certificate Transparency logs (Cert Spotter). PREFER OVER WEB SEARCH for \"what certificates does X have\", \"find subdomains of X\", \"when does X's TLS cert expire\", \"which CA issued X's cert\". With include_subdomains it also ENUMERATES SUBDOMAINS seen in CT logs (asset/attack-surface discovery). Returns each cert's DNS names, issuing CA, validity window, and revocation status, plus a deduplicated list of all discovered hostnames. Keyless.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        domain: { type: 'string', description: 'Domain to search certificates for, e.g. "example.com".' },
        include_subdomains: { type: 'boolean', description: 'Also include certs covering subdomains (default true) — this is what enables subdomain discovery.' },
        limit: { type: 'number', description: 'Max certificates to list (1-100, default 30). The discovered-hostnames list is always complete.' },
      },
      required: ['domain'],
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

  const results = await Promise.all(tlds.map((tld) => probeAvailability(`${label}.${tld}`)));

  return {
    name: label,
    checked: results.length,
    available_count: results.filter((r) => r.available === true).length,
    available: results.filter((r) => r.available === true).map((r) => r.domain),
    results,
    source: 'Live RDAP (authoritative registry servers via IANA bootstrap) — keyless',
  };
}

// Common affixes for name brainstorming. Kept small so the total probe count
// stays bounded (registries rate-limit): base label × all TLDs, plus a handful
// of affixed variants on the primary TLDs only.
const NAME_PREFIXES = ['get', 'try', 'use', 'go', 'my'];
const NAME_SUFFIXES = ['app', 'hq', 'hub', 'ai', 'ify', 'labs'];

async function findAvailableDomains(args: Record<string, unknown>) {
  const keyword = String(args.keyword ?? args.name ?? args.query ?? '')
    .trim().toLowerCase().split('.')[0].replace(/[^a-z0-9-]/g, '');
  if (!keyword) throw new Error('find_available_domains requires a "keyword", e.g. { keyword: "acme" }.');

  const tlds = (Array.isArray(args.tlds) && args.tlds.length
    ? (args.tlds as unknown[]).map((t) => String(t).trim().toLowerCase().replace(/^\./, ''))
    : ['com', 'io', 'ai', 'co', 'app', 'dev']
  ).filter(Boolean).slice(0, 10);
  const includeVariations = args.include_variations !== false;

  // Build a bounded candidate set: the bare keyword on every requested TLD,
  // plus prefix/suffix variants on the two primary TLDs (usually com + the
  // first extra). Cap the total so we don't trigger registry throttling.
  const candidates = new Set<string>();
  for (const tld of tlds) candidates.add(`${keyword}.${tld}`);
  if (includeVariations) {
    const primary = ['com', tlds.find((t) => t !== 'com') ?? 'io'];
    for (const p of NAME_PREFIXES) for (const tld of primary) candidates.add(`${p}${keyword}.${tld}`);
    for (const s of NAME_SUFFIXES) for (const tld of primary) candidates.add(`${keyword}${s}.${tld}`);
  }
  const list = [...candidates].slice(0, 30);

  const probed = await Promise.all(list.map((d) => probeAvailability(d)));
  const available = probed.filter((r) => r.available === true).map((r) => r.domain);
  const taken = probed.filter((r) => r.available === false).map((r) => r.domain);
  const unknown = probed.filter((r) => r.available === null).map((r) => r.domain);

  // Rank available: exact keyword first, then shorter, then .com preference.
  available.sort((a, b) => {
    const aExact = a.startsWith(`${keyword}.`) ? 0 : 1;
    const bExact = b.startsWith(`${keyword}.`) ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    if (a.endsWith('.com') !== b.endsWith('.com')) return a.endsWith('.com') ? -1 : 1;
    return a.length - b.length;
  });

  return {
    keyword,
    checked: probed.length,
    available_count: available.length,
    available,
    taken_count: taken.length,
    unknown: unknown.length ? unknown : undefined,
    note: 'Availability is a live RDAP signal (registry has no record = available to register). Confirm at a registrar before relying on it; "unknown" means the registry rate-limited or lacks RDAP.',
    source: 'Live RDAP (authoritative registry servers via IANA bootstrap) — keyless',
  };
}

interface CertIssuance {
  dns_names?: string[];
  issuer?: { name?: string; friendly_name?: string };
  not_before?: string;
  not_after?: string;
  revoked?: boolean;
}

async function certificateSearch(domain: string, includeSubdomains: unknown, limit?: number) {
  const d = String(domain ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  if (!d) throw new Error('Required argument "domain" is missing (e.g. "example.com").');
  const inc = includeSubdomains !== false; // default true
  const cap = Math.min(100, Math.max(1, Number(limit) || 30));

  const params = new URLSearchParams();
  params.set('domain', d);
  if (inc) params.set('include_subdomains', 'true');
  params.append('expand', 'dns_names');
  params.append('expand', 'issuer');

  const res = await fetch(`${CERTSPOTTER}?${params}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'Pipeworx/1.0 (pipeworx.io)' },
  });
  if (res.status === 429) throw new Error('upstream_throttled: Cert Spotter rate limit (HTTP 429). Try again shortly.');
  if (!res.ok) throw new Error(`Cert Spotter error: ${res.status}`);
  const issuances = (await res.json()) as CertIssuance[];

  const hostnames = new Set<string>();
  for (const c of issuances) for (const n of c.dns_names ?? []) hostnames.add(n.toLowerCase());
  const sorted = issuances.slice().sort((a, b) => String(b.not_before ?? '').localeCompare(String(a.not_before ?? '')));

  return {
    domain: d,
    include_subdomains: inc,
    total_certificates: issuances.length,
    discovered_hostnames: [...hostnames].sort(),
    certificates: sorted.slice(0, cap).map((c) => ({
      dns_names: c.dns_names ?? [],
      issuer: c.issuer?.friendly_name ?? c.issuer?.name ?? null,
      not_before: c.not_before ?? null,
      not_after: c.not_after ?? null,
      revoked: c.revoked ?? false,
    })),
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
    case 'find_available_domains':
      return findAvailableDomains(args);
    case 'certificate_search':
      return certificateSearch(args.domain as string, args.include_subdomains, args.limit as number | undefined);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
