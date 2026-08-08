// adapters/consider.mjs — Consider (getconsider.com) VC portfolio job board adapter.
//
// Consider powers VC "talent network" portfolio boards (e.g. Founderful,
// Creandum, Balderton, Lightspeed, Notion Capital — verify per fund). The
// board is a JS app, but its data comes from a same-origin JSON endpoint:
//
//   POST {board_origin}/api-boards/search-jobs
//   body: {"meta":{"size":500},"board":{"id":"<board_id>","isParent":true},
//          "query":{"promoteFeatured":true}}
//   -> { jobs: [ {title,url,applyUrl,companyName,locations[],timeStamp,remote} ], total }
//
// The board id is a slug (NOT the host — e.g. Founderful's is "wingman"), so
// it must be set explicitly on the company record as `consider_board`, along
// with a `website`/`ats_links` entry pointing at the board's https origin:
//
//   { "name": "Founderful Portfolio", "website": "https://jobs.founderful.com",
//     "ats_links": ["https://jobs.founderful.com/jobs"], "consider_board": "wingman" }

export const ATS = 'consider';

const ENDPOINT_PATH = '/api-boards/search-jobs';
// Server hard-caps `meta.size` at 1000 (confirmed: size:10000 returns a 422
// "Input should be less than or equal to 1000").
//
// This is a hard platform ceiling, not a tunable page size: neither
// `meta.from` nor `meta.page` change the returned results — tested directly
// against Sequoia Capital's board (9,723 total jobs), requesting
// {from:0,size:3} vs {from:3,size:3} vs {page:1,size:3} all returned the
// identical top 3 jobs. The endpoint is a "top N by relevance/featured" read,
// not an offset-paginated listing, so there is no way to reach jobs past
// index 1000 through this API. A prior version of this file attempted
// from-based pagination and silently fetched 10,000 duplicate rows (the same
// 1,000 jobs 10 times) — don't reintroduce that.
const MAX_SIZE = 1000;

function candidateUrls(company) {
  const urls = [];
  if (Array.isArray(company?.ats_links)) urls.push(...company.ats_links);
  if (company?.website) urls.push(company.website);
  if (company?.ats_url) urls.push(company.ats_url);
  if (company?.careers_url) urls.push(company.careers_url);
  return urls.filter(Boolean);
}

// SSRF guard — the POST target host is derived from company-record data, so
// pin it to a public HTTPS origin before fetching. Rejects non-HTTPS,
// IP-literal, and loopback/internal hosts (127.0.0.1, cloud-metadata IPs,
// localhost, *.internal, *.local).
function resolveOrigin(company) {
  for (const raw of candidateUrls(company)) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:') continue;
    let host = parsed.hostname.toLowerCase();
    if (host.endsWith('.')) host = host.slice(0, -1);
    if (host.startsWith('[') || host.includes(':')) continue;           // IPv6 literal
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) continue;                 // IPv4 literal
    if (host === 'localhost' || host === 'localhost.localdomain') continue;
    if (host.endsWith('.local') || host.endsWith('.internal')) continue;
    if (!host.includes('.')) continue;                                  // non-public
    return parsed.origin;
  }
  return null;
}

function locationString(job) {
  if (Array.isArray(job.locations) && job.locations.length) {
    return job.locations.filter(l => typeof l === 'string').join(', ');
  }
  if (Array.isArray(job.normalizedLocations) && job.normalizedLocations.length) {
    return job.normalizedLocations.map(l => l?.label || l?.value).filter(Boolean).join(', ');
  }
  return job.remote ? 'Remote' : '';
}

function toIsoDate(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return '';
    const ms = value < 1_000_000_000_000 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) || ms <= 0 ? '' : new Date(ms).toISOString();
}

export function detect(company) {
  if (!company?.consider_board) return null;
  const origin = resolveOrigin(company);
  if (!origin) return null;
  return {
    boardId: String(company.consider_board),
    origin,
    apiUrl: origin + ENDPOINT_PATH,
  };
}

function normalizeJob(j, origin) {
  const rawUrl = j.url || j.applyUrl || '';
  if (!rawUrl) return null;
  let detailUrl;
  try {
    detailUrl = new URL(rawUrl, origin).toString();
  } catch {
    return null;
  }
  const title = j.title || '';
  const location = locationString(j);
  return {
    title,
    detail_url: detailUrl,
    apply_url: detailUrl,
    location,
    remote: !!j.remote || /\bremote\b/i.test(location),
    department: '',
    posted_date: toIsoDate(j.timeStamp),
    employment_type: '',
    // Portfolio jobs belong to the portfolio company, not the fund.
    company: j.companyName || '',
    raw: j,
  };
}

export async function fetchJobs(handle, ctx) {
  if (!handle?.apiUrl) return [];
  try {
    const json = await ctx.fetchJson(handle.apiUrl, {
      method: 'POST',
      // origin is pinned to a public https host by resolveOrigin() above.
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        referer: handle.origin + '/jobs',
      },
      body: JSON.stringify({
        meta: { size: MAX_SIZE },
        board: { id: handle.boardId, isParent: true },
        query: { promoteFeatured: true },
      }),
    });

    const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
    const out = [];
    for (const j of jobs) {
      const normalized = normalizeJob(j, handle.origin);
      if (normalized) out.push(normalized);
    }
    // Platform ceiling, not our bug — see MAX_SIZE comment above.
    if (typeof json?.total === 'number' && json.total > out.length && ctx?.logWarn) {
      ctx.logWarn(`consider ${handle.boardId}: board reports ${json.total} jobs, API caps a single read at ${MAX_SIZE} with no working pagination — ${json.total - out.length} jobs unreachable`);
    }
    return out;
  } catch (err) {
    if (ctx?.logWarn) ctx.logWarn(`consider ${handle.boardId}: ${err.message}`);
    return [];
  }
}
