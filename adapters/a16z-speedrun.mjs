// adapters/a16z-speedrun.mjs — a16z Speedrun Talent Network adapter.
//
// Board-wide aggregator feed covering ~200 a16z-portfolio / Speedrun-program
// companies (not a single-company ATS). One feed call returns jobs for many
// different employers, so each returned job also carries a `company` field
// naming the actual portfolio company — harvest.mjs is expected to prefer
// that over the routed company name.
//
// API: https://speedrun-talent-network.com/api/v1/jobs?page=N&source=career-ops
//   0-indexed pages, 50/page. Response: { jobs: [...], total_pages, ... }
// Public, zero-auth.
//
// A 355-page sweep is one bare try/catch around the whole loop away from a
// single transient blip silently truncating the result to whatever was
// collected so far — confirmed as the real cause of a session-observed gap
// (17,727 real jobs live-checked, but a full sweep run only returned
// 12,650): the API itself was healthy (a direct probe got a clean 200
// immediately after), so something mid-walk failed once and the missing
// retry logic just gave up rather than being an ongoing block. Retry
// transient errors before propagating.

export const ATS = 'a16z-speedrun';

const FEED_BASE = 'https://speedrun-talent-network.com/api/v1/jobs';
const TRUSTED_HOST = 'speedrun-talent-network.com';
const PER_PAGE = 50;
// The board is ~355 pages / ~17.7k jobs as of 2026-08-08 — this must stay
// comfortably above that (not 6, which silently truncated a full-board sweep
// to 300 jobs). Iteration still stops at the feed's reported total_pages (or
// a short page) well before this default is exhausted on an honest feed.
const DEFAULT_MAX_PAGES = 500;
// Runaway guard, not a coverage target — sits well above plausible board size.
const MAX_PAGES_CAP = 1000;
const RETRY_STATUSES = [429, 502, 503, 504];
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1500;

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

export function detect(company) {
  for (const url of candidateUrls(company)) {
    if (isTrustedHost(url)) {
      return { host: TRUSTED_HOST };
    }
  }
  return null;
}

function resolveMaxPages(handle) {
  const v = handle?.maxPages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

function isRemote(title, location, remoteFlag) {
  if (remoteFlag === true) return true;
  const hay = `${title || ''} ${location || ''}`.toLowerCase();
  return /\bremote\b|\banywhere\b|work from home/.test(hay);
}

function normalizeJob(j) {
  const title = typeof j?.title === 'string' ? j.title.trim() : '';
  if (!title) return null;

  let detailUrl = '';
  const rawUrl = typeof j?.url === 'string' ? j.url.trim() : '';
  if (rawUrl && isTrustedHost(rawUrl)) detailUrl = rawUrl;
  if (!detailUrl) return null;

  const company = typeof j?.company === 'string' && j.company.trim() ? j.company.trim() : '';
  const location = typeof j?.location === 'string' ? j.location.trim() : '';

  return {
    title,
    detail_url: detailUrl,
    apply_url: detailUrl,
    location,
    remote: isRemote(title, location, j?.remote),
    department: '',
    posted_date: typeof j?.published_at === 'string' ? j.published_at : '',
    employment_type: '',
    raw: j,
    company,
  };
}

export async function fetchJobs(handle, ctx) {
  if (!handle?.host) return [];
  const maxPages = resolveMaxPages(handle);
  const out = [];
  try {
    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams({ page: String(page), source: 'career-ops' });
      const url = `${FEED_BASE}?${params}`;
      // redirect:'error' prevents SSRF via server-side redirects off-host.
      const json = await fetchJsonWithRetry(ctx, url, { redirect: 'error' });
      const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
      for (const j of jobs) {
        const normalized = normalizeJob(j);
        if (normalized) out.push(normalized);
      }
      // Stop at the last page: a short page, or past the reported total_pages.
      if (jobs.length < PER_PAGE) break;
      if (Number.isInteger(json?.total_pages) && page + 1 >= json.total_pages) break;
    }
    return out;
  } catch (err) {
    if (ctx?.logWarn) ctx.logWarn(`a16z-speedrun: ${err.message}`);
    return out.length ? out : [];
  }
}
