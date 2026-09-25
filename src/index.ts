interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
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


// Bound the fetch() calls in this pack that pass no signal of their own — a
// file with one guarded call still reads as "guarded" to the file-level grep
// while its other call sites hang unbounded (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Domains');
}

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
      const res = await pwFetch(IANA_BOOTSTRAP, { headers: { Accept: 'application/json' } });
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
  const res = await pwFetch(`${RDAP_BASE}/domain/${encodeURIComponent(domain.toLowerCase())}`, {
    headers: { Accept: 'application/rdap+json, application/json', 'User-Agent': 'Pipeworx/1.0 (pipeworx.io)' },
    redirect: 'follow',
  });
  if (res.status === 404) return { domain, registered: false, error: 'Domain not found in RDAP' };
  if (!res.ok) throw await httpError(res, 'RDAP error');

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
  const res = await pwFetch(`${RDAP_BASE}/domain/${encodeURIComponent(domain.toLowerCase())}`, {
    headers: { Accept: 'application/rdap+json, application/json', 'User-Agent': 'Pipeworx/1.0 (pipeworx.io)' },
    redirect: 'follow',
  });

  if (res.status === 404) return { domain, registered: false, available: true };
  if (!res.ok) throw await httpError(res, 'RDAP error');

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

  const res = await pwFetch(`${CERTSPOTTER}?${params}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'Pipeworx/1.0 (pipeworx.io)' },
  });
  if (res.status === 429) throw new Error('upstream_throttled: Cert Spotter rate limit (HTTP 429). Try again shortly.');
  if (!res.ok) throw await httpError(res, 'Cert Spotter error');
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
