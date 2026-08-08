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
//
// DESIGN NOTE — this adapter is intentionally NOT part of harvest.mjs's
// default full sweep (see harvest.mjs's OPT_IN_ATS gate). A fresh clone of
// this repo would otherwise blindly try to pull all ~168k jobs on its very
// first run and immediately trip jobs.workable.com's IP rate limiter
// (confirmed live during development — a sustained 429 that a 5-retry/32s
// backoff still couldn't clear). Three safety nets instead:
//
//   1. Opt-in only — reachable via `--company "Workable Job Board"`,
//      `--ats workable-search`, or `--include-aggregators`; skipped by a bare
//      `node harvest.mjs`.
//   2. Server-side filtering — `handle.query` (harvest's --workable-query)
//      and `handle.remoteOnly` (--workable-remote) narrow the search on
//      Workable's side, so a scoped run fetches a few hundred relevant jobs
//      instead of walking the whole board.
//   3. Resumable cursor — each run fetches only DEFAULT_PAGES_PER_RUN pages
//      (handle.maxPages / --workable-max-pages to override) and persists its
//      `pageToken` to data/workable-search-cursor.json (gitignored), so
//      repeated runs walk the board incrementally across days instead of
//      re-fetching page 1 or trying to do it all in one sitting. The cursor
//      is keyed by the filter combo (query + remoteOnly) so differently
//      filtered runs walk independently. When the board is exhausted the
//      cursor is cleared, so the next run starts a fresh cycle and picks up
//      newly-posted jobs. `handle.resetCursor` (--workable-reset) forces a
//      restart from page 1.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

export const ATS = 'workable-search';

const FEED_BASE = 'https://jobs.workable.com/api/v1/jobs';
const TRUSTED_HOST = 'jobs.workable.com';
// Sentinel path on the trusted host that routes a synthetic company record to
// this board-wide adapter instead of the per-company workable.mjs adapter
// (which matches apply.workable.com, so the two never collide).
const SENTINEL_PATH = '/search';
// Server-enforced page size — not tunable.
const PER_PAGE = 20;
// Default pages fetched PER RUN, not a full-sweep target — deliberately small
// (40 pages = 800 jobs) so a first-time `node harvest.mjs --company "Workable
// Job Board"` is fast and gentle on the rate limiter. Override with
// handle.maxPages (harvest.mjs's --workable-max-pages) for a bigger bite, or
// just run it repeatedly — the cursor below carries you further each time.
const DEFAULT_PAGES_PER_RUN = 40;
// Runaway guard for a single run, not a coverage target — the board is
// ~168.4k jobs / ~8,423 pages, so this sits comfortably above any sane
// --workable-max-pages override while still bounding a single invocation.
const MAX_PAGES_CAP = 10000;
// jobs.workable.com IP-rate-limits aggressively (confirmed live: a 429 after
// heavy testing that even 5 retries with exponential backoff couldn't clear).
// Retry transient errors, and pace requests to reduce how often the limiter
// trips in the first place.
const RETRY_STATUSES = [429, 502, 503, 504];
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 2000;
const PACE_MS = 400;

const CURSOR_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'workable-search-cursor.json');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Cursor state is keyed by the query/remoteOnly combo so different filtered
// runs (e.g. "growth marketing" vs "engineering") each walk independently.
function cursorKey(handle) {
  return JSON.stringify({ q: handle?.query || '', remote: !!handle?.remoteOnly });
}

function loadCursor(key) {
  if (!existsSync(CURSOR_PATH)) return null;
  try {
    const all = JSON.parse(readFileSync(CURSOR_PATH, 'utf-8'));
    return all[key] || null;
  } catch {
    return null;
  }
}

function saveCursor(key, entry) {
  let all = {};
  if (existsSync(CURSOR_PATH)) {
    try { all = JSON.parse(readFileSync(CURSOR_PATH, 'utf-8')); } catch { /* start fresh */ }
  }
  if (entry === null) delete all[key];
  else all[key] = entry;
  mkdirSync(dirname(CURSOR_PATH), { recursive: true });
  writeFileSync(CURSOR_PATH, JSON.stringify(all, null, 2));
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

function resolvePagesPerRun(handle) {
  const v = handle?.maxPages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_PAGES_PER_RUN;
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
  const pagesPerRun = resolvePagesPerRun(handle);
  const key = cursorKey(handle);

  // Resume where the previous run stopped, unless explicitly reset.
  const prev = handle?.resetCursor === true ? null : loadCursor(key);
  let pageToken = typeof prev?.pageToken === 'string' ? prev.pageToken : '';
  const resumed = !!pageToken;
  let pagesWalked = Number.isInteger(prev?.pagesWalked) ? prev.pagesWalked : 0;

  const out = [];
  const seen = new Set();
  // `cycleDone` means the board was fully walked (or the saved token turned
  // out to be unusable), so the cursor is cleared and the next run restarts
  // from page 1 — which is also how newly-posted jobs get picked up.
  let cycleDone = false;
  let pagesThisRun = 0;
  let totalSize = Number.isInteger(prev?.totalSize) ? prev.totalSize : null;

  try {
    for (let page = 0; page < pagesPerRun; page++) {
      const params = new URLSearchParams();
      if (pageToken) params.set('pageToken', pageToken);
      if (typeof handle.query === 'string' && handle.query.trim()) {
        params.set('query', handle.query.trim());
      }
      if (handle.remoteOnly === true) params.set('workplace', 'remote');
      const qs = params.toString();
      const url = qs ? `${FEED_BASE}?${qs}` : FEED_BASE;
      // Pace between requests (not before the first) to stay under the limiter.
      if (page > 0) await sleep(PACE_MS);
      // redirect:'error' prevents SSRF via server-side redirects off-host.
      const json = await fetchJsonWithRetry(ctx, url, {
        redirect: 'error',
        headers: { Accept: 'application/json' },
      });

      const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
      for (const j of jobs) {
        const id = j?.id;
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        const normalized = normalizeJob(j);
        if (normalized) out.push(normalized);
      }
      pagesWalked++;
      pagesThisRun++;
      if (Number.isInteger(json?.totalSize)) totalSize = json.totalSize;

      // End-of-board conditions, cheapest first. Any of them means this cycle
      // is complete — the cursor gets cleared so the next run starts over.
      if (jobs.length < PER_PAGE) { cycleDone = true; break; }
      const next = typeof json?.nextPageToken === 'string' ? json.nextPageToken : '';
      if (!next) { cycleDone = true; break; }
      pageToken = next;
      if (Number.isInteger(totalSize) && pagesWalked * PER_PAGE >= totalSize) { cycleDone = true; break; }
    }
  } catch (err) {
    if (ctx?.logWarn) ctx.logWarn(`workable-search: ${err.message}`);
    // A resumed token rejected outright (4xx that isn't rate limiting) on the
    // first request of the run is expired server-side — drop it so the next
    // run isn't permanently stuck. Rate limiting / 5xx keep the cursor, since
    // the token is presumably still fine and progress is worth preserving.
    const status = statusFromError(err);
    const tokenRejected = status >= 400 && status < 500 && !RETRY_STATUSES.includes(status);
    if (resumed && pagesThisRun === 0 && tokenRejected) cycleDone = true;
  }

  const cleared = cycleDone || !pageToken;
  try {
    if (cleared) {
      // Cycle complete, or nothing worth resuming from (e.g. the first request
      // of a fresh run failed) — clear so the next run starts at page 1.
      saveCursor(key, null);
    } else {
      saveCursor(key, {
        pageToken,
        pagesWalked,
        totalSize,
        query: handle?.query || '',
        remoteOnly: !!handle?.remoteOnly,
        updatedAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    if (ctx?.logWarn) ctx.logWarn(`workable-search: cursor write failed: ${err.message}`);
  }

  if (ctx?.logWarn) {
    ctx.logWarn(`workable-search: +${out.length} jobs, pages walked ${pagesWalked}${totalSize ? ` / ~${Math.ceil(totalSize / PER_PAGE)}` : ''}${cleared ? ' (cursor cleared — next run restarts at page 1)' : ' (cursor saved — next run resumes here)'}`);
  }
  return out;
}
