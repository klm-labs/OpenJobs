// adapters/getro.mjs — Getro "talent network" VC portfolio job board adapter.
//
// Getro powers many VC portfolio-company job boards (e.g. Atomico, HV Capital,
// Cherry, b2venture, Point Nine, Speedinvest, Earlybird — verify per fund,
// vendors change). Public API:
//
//   POST https://api.getro.com/api/v2/collections/{collection_id}/search/jobs
//   body: {"hitsPerPage":20,"page":P}
//   -> { results: { jobs: [ {title,url,organization:{name},locations[],created_at} ], count } }
//
// The numeric collection_id is the `network.id` embedded in the board page's
// __NEXT_DATA__ blob — it can't be derived from the board URL, so it must be
// set explicitly on the company record as `getro_collection` (numeric), e.g.:
//
//   { "name": "Atomico Portfolio", "website": "https://jobs.atomico.com",
//     "ats_links": ["https://jobs.atomico.com"], "getro_collection": 1234 }
//
// These boards are large (1000-2000+ jobs total) served newest-first, so we
// paginate with a hard page cap rather than an age cutoff (this repo's
// harvest.mjs applies posted-date filtering downstream; adapters just fetch).

export const ATS = 'getro';

const API_BASE = 'https://api.getro.com/api/v2/collections';
const HITS_PER_PAGE = 20;   // API hard-caps page size at 20 (confirmed: requesting more still returns 20)
// Some boards (e.g. Accel) run 26k+ jobs — 40 pages (800 jobs) was silently
// truncating those to ~3% of the real board. This is a runaway guard, not a
// coverage target: the loop already stops at the API's own `count` field.
const MAX_PAGES = 2000;     // safety cap: 2000 x 20 = 40,000 newest jobs/board

export function detect(company) {
  const id = company?.getro_collection;
  if (id == null) return null;
  const s = String(id).trim();
  if (!/^\d+$/.test(s)) return null;
  return {
    collectionId: s,
    apiUrl: `${API_BASE}/${s}/search/jobs`,
  };
}

function isRemote(title, location) {
  const hay = `${title || ''} ${location || ''}`.toLowerCase();
  return /\bremote\b|\banywhere\b|work from home/.test(hay);
}

// Getro returns `created_at` as Unix seconds on most boards, ISO strings on
// some older ones — normalize both to an ISO string for posted_date.
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

export async function fetchJobs(handle, ctx) {
  if (!handle?.apiUrl) return [];
  const out = [];
  try {
    let total = Infinity;
    for (let page = 0; page < MAX_PAGES && page * HITS_PER_PAGE < total; page++) {
      const json = await ctx.fetchJson(handle.apiUrl, {
        method: 'POST',
        // apiUrl is pinned to api.getro.com — don't follow a 3xx off that host.
        redirect: 'error',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ hitsPerPage: HITS_PER_PAGE, page }),
      });
      const results = json?.results || {};
      const jobs = Array.isArray(results.jobs) ? results.jobs : [];
      if (typeof results.count === 'number') total = results.count;
      if (jobs.length === 0) break;

      for (const j of jobs) {
        const detailUrl = j.url || '';
        if (!detailUrl) continue;
        const location = (Array.isArray(j.locations) && j.locations[0])
          || (Array.isArray(j.searchable_locations) && j.searchable_locations[0])
          || '';
        const title = j.title || '';
        out.push({
          title,
          detail_url: detailUrl,
          apply_url: detailUrl,
          location,
          remote: isRemote(title, location),
          department: '',
          posted_date: toIsoDate(j.created_at),
          employment_type: '',
          // Portfolio jobs belong to the portfolio company, not the fund —
          // expose the real employer so harvest.mjs can override the routed
          // company name.
          company: j.organization?.name || j.organization_name || '',
          raw: j,
        });
      }
      if (jobs.length < HITS_PER_PAGE) break;
    }
    return out;
  } catch (err) {
    if (ctx?.logWarn) ctx.logWarn(`getro ${handle.collectionId}: ${err.message}`);
    return out;
  }
}
