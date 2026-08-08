// adapters/workable.mjs — Workable (apply.workable.com) adapter.
//
// API: POST https://apply.workable.com/api/v3/accounts/{slug}/jobs
//   body: {}  (pagination: { token: <nextPage from prev response> })
//   response: { total, results: [...], nextPage: "<base64 token>" | null }
// Public board URL: https://apply.workable.com/{slug}/
//
// hardCap was 500 with no reference to the API's own `total` field — same
// truncation-bug class already found and fixed in getro/consider/
// a16z-speedrun/workday/smartrecruiters this session. Raised well past any
// single-company board size (`total` naturally bounds the loop for normal
// companies; this is a runaway guard, not a coverage target).
//
// apply.workable.com shares Workable's aggressive IP rate limiting with
// jobs.workable.com (confirmed live this session: a sustained 429 that
// outlasted a 62s exponential backoff) — retry transient errors rather than
// letting one blip during a full harvest sweep silently zero out a company.

export const ATS = 'workable';

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

const HOST_PATTERNS = [
  /apply\.workable\.com\/api\/v3\/accounts\/([^/?#]+)/i,
  /apply\.workable\.com\/([^/?#]+)/i,
];

const EXCLUDE_SEGMENTS = new Set(['api', 'v3', 'accounts', 'j', 'jobs']);

function candidateUrls(company) {
  const urls = [];
  if (Array.isArray(company?.ats_links)) urls.push(...company.ats_links);
  if (company?.ats_url) urls.push(company.ats_url);
  if (company?.careers_url) urls.push(company.careers_url);
  if (company?.api) urls.push(company.api);
  return urls.filter(Boolean);
}

function matchSlug(url) {
  for (const re of HOST_PATTERNS) {
    const m = url.match(re);
    if (m && m[1] && !EXCLUDE_SEGMENTS.has(m[1].toLowerCase())) {
      return decodeURIComponent(m[1]);
    }
  }
  return null;
}

export function detect(company) {
  for (const url of candidateUrls(company)) {
    const slug = matchSlug(url);
    if (slug) return buildHandle(slug);
  }
  return null;
}

function buildHandle(slug) {
  return {
    slug,
    apiUrl: `https://apply.workable.com/api/v3/accounts/${encodeURIComponent(slug)}/jobs`,
    boardUrl: `https://apply.workable.com/${encodeURIComponent(slug)}/`,
  };
}

function isRemote(title, location, flags) {
  if (flags?.remote === true) return true;
  if (flags?.workplace && /remote/i.test(flags.workplace)) return true;
  const hay = `${title || ''} ${location || ''}`.toLowerCase();
  return /\bremote\b|\banywhere\b|work from home|\bwfh\b/.test(hay);
}

function joinLocation(loc) {
  if (!loc || typeof loc !== 'object') return '';
  const parts = [loc.city, loc.region, loc.country].filter(Boolean);
  return parts.join(', ');
}

async function postJsonOnce(url, body, ctx) {
  if (ctx?.fetchJson && ctx.fetchJson.length >= 2) {
    try {
      return await ctx.fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Only fall through to a direct fetch for helper-shape issues, not HTTP
      // errors — an HTTP error is real signal (e.g. 429) that retry logic
      // above this call needs to see, not something to silently swallow.
      if (statusFromError(err) !== null) throw err;
    }
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function postJson(url, body, ctx) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await postJsonOnce(url, body, ctx);
    } catch (err) {
      const status = statusFromError(err);
      if (attempt >= MAX_RETRIES || !RETRY_STATUSES.includes(status)) throw err;
      await sleep(RETRY_BASE_MS * 2 ** attempt);
    }
  }
}

export async function fetchJobs(handle, ctx) {
  if (!handle?.apiUrl) return [];
  const all = [];
  const hardCap = 20000; // runaway guard, not a coverage target — see header comment
  try {
    let token = null;
    let guard = 0;
    let total = Infinity;
    while (all.length < hardCap && all.length < total && guard < 250) {
      guard++;
      const body = token ? { token } : {};
      const json = await postJson(handle.apiUrl, body, ctx);
      if (typeof json?.total === 'number' && json.total > 0) total = json.total;
      const results = json?.results || [];
      if (!Array.isArray(results) || results.length === 0) break;
      for (const j of results) {
        const title = j.title || '';
        const location = joinLocation(j.location);
        const shortcode = j.shortcode || j.id || '';
        const detailUrl = j.url || j.application_url
          || `${handle.boardUrl}j/${encodeURIComponent(shortcode)}/`;
        all.push({
          title,
          detail_url: detailUrl,
          apply_url: detailUrl,
          location,
          remote: isRemote(title, location, { remote: j.remote, workplace: j.workplace }),
          department: j.department || '',
          posted_date: j.published || j.created_at || '',
          employment_type: j.employment_type || j.type || '',
          raw: j,
        });
      }
      token = json?.nextPage || null;
      if (!token) break;
    }
    return all;
  } catch (err) {
    if (ctx?.logWarn) ctx.logWarn(`workable ${handle.slug}: ${err.message}`);
    return all;
  }
}
