// adapters/workable-search.mjs — Workable Job Board (jobs.workable.com) adapter.
//
// Board-wide aggregator feed covering EVERY company that publishes to
// Workable's public job board (~168k live jobs as of 2026-08-08), not a
// single-company ATS. This is distinct from `adapters/workable.mjs`, which
// hits apply.workable.com/api/v3/accounts/{slug}/jobs one company at a time
// and only covers the Workable slugs already present in companies_v2.json.
//
// One feed call returns jobs for many different employers, so each returned
// job also carries a `company` field naming the actual employer (from
// `job.company.title`) — harvest.mjs prefers that over the routed company
// name.
//
// API: GET https://jobs.workable.com/api/v1/jobs
//   Public, zero-auth (no CSRF / cookie / session needed — verified live).
//   Cursor pagination via `pageToken`; page 1 is the bare URL, each response
//   returns `nextPageToken` for the next page. `limit` is server-capped at 20
//   (`limit=50` -> HTTP 400 {"limit":"Must be less than or equal to 20"}).
//   Response: { title, totalSize, nextPageToken, jobs: [...] }
//   Optional filters (both verified): `query=<free text>`, `workplace=remote`.

export const ATS = 'workable-search';

const FEED_BASE = 'https://jobs.workable.com/api/v1/jobs';
const TRUSTED_HOST = 'jobs.workable.com';
// Sentinel path on the trusted host that routes a synthetic company record to
// this board-wide adapter instead of the per-company workable.mjs adapter
// (which matches apply.workable.com, so the two never collide).
const SENTINEL_PATH = '/search';
// Server-enforced page size — not tunable.
const PER_PAGE = 20;
// The board is ~168.4k jobs / ~8,423 pages at 20/page as of 2026-08-08. This
// default must stay comfortably above that so a full sweep is actually
// reachable (cf. a16z-speedrun, whose DEFAULT_MAX_PAGES=6 silently truncated
// a 17.7k-job feed to 300). Iteration still stops early on a missing
// nextPageToken, a short page, or once totalSize has been covered.
const DEFAULT_MAX_PAGES = 12000;
// Runaway guard, not a coverage target — sits well above plausible board size.
const MAX_PAGES_CAP = 25000;
// jobs.workable.com IP-rate-limits aggressively (confirmed live: a 429 after
// heavy testing) — the repo's own docs already flag apply.workable.com/{slug}
// as the same. A full sweep is ~8,423 pages, so without retry a single 429
// mid-sweep silently truncates the whole board (observed: stopped at 7,560
// jobs / ~378 pages). Retry with backoff, and pace requests to reduce how
// often the limiter trips in the first place.
const RETRY_STATUSES = [429, 502, 503, 504];
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 2000;
const PACE_MS = 150;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusFromError(err) {
  const m = /HTTP (\d+)/.exec(err?.message || '');
  return m ? Number(m[1]) : null;
}

async function fetchJsonWithRetry(ctx, url, opts) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await ctx.fetchJson(url, opts);
    } catch (err) {
      const status = statusFromError(err);
      if (attempt >= MAX_RETRIES || !RETRY_STATUSES.includes(status)) throw err;
      await sleep(RETRY_BASE_MS * 2 ** attempt);
    }
  }
}

function candidateUrls(company) {
  const urls = [];
  if (Array.isArray(company?.ats_links)) urls.push(...company.ats_links);
  if (company?.ats_url) urls.push(company.ats_url);
  if (company?.careers_url) urls.push(company.careers_url);
  if (company?.api) urls.push(company.api);
  return urls.filter(Boolean);
}

function isTrustedHost(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === TRUSTED_HOST;
  } catch {
    return false;
  }
}

function isSentinel(url) {
  if (!isTrustedHost(url)) return false;
  try {
    return new URL(url).pathname.replace(/\/+$/, '') === SENTINEL_PATH;
  } catch {
    return false;
  }
}

export function detect(company) {
  for (const url of candidateUrls(company)) {
    if (isSentinel(url)) return { host: TRUSTED_HOST };
  }
  return null;
}

function resolveMaxPages(handle) {
  const v = handle?.maxPages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

function formatLocation(j) {
  if (Array.isArray(j?.locations) && j.locations.length) {
    return j.locations.filter((s) => typeof s === 'string' && s.trim()).join('; ');
  }
  const loc = j?.location;
  if (loc && typeof loc === 'object') {
    return [loc.city, loc.subregion, loc.countryName].filter(Boolean).join(', ');
  }
  return '';
}

function isRemote(title, location, workplace) {
  if (typeof workplace === 'string' && workplace.toLowerCase() === 'remote') return true;
  const hay = `${title || ''} ${location || ''}`.toLowerCase();
  return /\bremote\b|\banywhere\b|work from home/.test(hay);
}

// Keep `raw` small: the upstream record embeds full job + company description
// HTML, which would balloon memory across a 168k-job sweep.
function slimRaw(j) {
  return {
    id: j?.id,
    title: j?.title,
    department: j?.department,
    employmentType: j?.employmentType,
    workplace: j?.workplace,
    locations: j?.locations,
    created: j?.created,
    updated: j?.updated,
    url: j?.url,
    company: {
      id: j?.company?.id,
      title: j?.company?.title,
      website: j?.company?.website,
      url: j?.company?.url,
    },
  };
}

function normalizeJob(j) {
  const title = typeof j?.title === 'string' ? j.title.trim() : '';
  if (!title) return null;

  const rawUrl = typeof j?.url === 'string' ? j.url.trim() : '';
  if (!rawUrl || !isTrustedHost(rawUrl)) return null;

  const company = typeof j?.company?.title === 'string' ? j.company.title.trim() : '';
  const location = formatLocation(j);

  return {
    title,
    detail_url: rawUrl,
    apply_url: rawUrl,
    location,
    remote: isRemote(title, location, j?.workplace),
    department: typeof j?.department === 'string' ? j.department : '',
    posted_date: typeof j?.created === 'string' ? j.created : '',
    employment_type: typeof j?.employmentType === 'string' ? j.employmentType : '',
    raw: slimRaw(j),
    company,
  };
}

export async function fetchJobs(handle, ctx) {
  if (!handle?.host) return [];
  const maxPages = resolveMaxPages(handle);
  const out = [];
  const seen = new Set();
  let pageToken = '';
  try {
    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams();
      if (pageToken) params.set('pageToken', pageToken);
      if (typeof handle.query === 'string' && handle.query.trim()) {
        params.set('query', handle.query.trim());
      }
      if (handle.remoteOnly === true) params.set('workplace', 'remote');
      const qs = params.toString();
      const url = qs ? `${FEED_BASE}?${qs}` : FEED_BASE;
      // redirect:'error' prevents SSRF via server-side redirects off-host.
      const json = await fetchJsonWithRetry(ctx, url, {
        redirect: 'error',
        headers: { Accept: 'application/json' },
      });
      if (page > 0) await sleep(PACE_MS);

      const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
      for (const j of jobs) {
        const id = j?.id;
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        const normalized = normalizeJob(j);
        if (normalized) out.push(normalized);
      }

      // Stop conditions, cheapest first.
      if (jobs.length < PER_PAGE) break;
      pageToken = typeof json?.nextPageToken === 'string' ? json.nextPageToken : '';
      if (!pageToken) break;
      if (Number.isInteger(json?.totalSize) && seen.size >= json.totalSize) break;
    }
    return out;
  } catch (err) {
    if (ctx?.logWarn) ctx.logWarn(`workable-search: ${err.message}`);
    return out;
  }
}
