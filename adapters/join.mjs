// adapters/join.mjs — Join.com adapter.
//
// join.com serves a Next.js-rendered board at https://join.com/companies/{slug}.
// There is no working public JSON endpoint (the api/public/companies/{slug}/jobs
// endpoint exists but rejects every pageSize/page value we tried with a 400 —
// likely gated/internal-only).
//
// TRUNCATION BUG (found live, fixed here): the board page is server-rendered
// but paginated at just 5 jobs/page — confirmed live against Enterprise Bot's
// board, which reports pagination.total:12 with pageCount:3, while the old
// single-fetch version of this adapter only ever read page 1 and returned 5
// of the 12 jobs. The fix: `?page=N` on the board URL is real pagination
// (verified: page 1/2/3 each return distinct, non-overlapping job titles) —
// the embedded Next.js `__NEXT_DATA__` script on every page exposes
// `initialState.jobs.{items,pagination}`, which we now walk page-by-page
// using the API's own `pagination.pageCount`. JSON-LD / anchor-scrape of a
// single page remain as fallbacks for boards where __NEXT_DATA__ is absent.

export const ATS = 'join';

const HOST_PATTERNS = [
  /join\.com\/companies\/([^/?#]+)/i,
];

function candidateUrls(company) {
  const urls = [];
  if (Array.isArray(company?.ats_links)) urls.push(...company.ats_links);
  if (company?.ats_url) urls.push(company.ats_url);
  if (company?.careers_url) urls.push(company.careers_url);
  if (company?.listUrl) urls.push(company.listUrl);
  if (company?.api) urls.push(company.api);
  return urls.filter(Boolean);
}

function matchSlug(url) {
  for (const re of HOST_PATTERNS) {
    const m = url.match(re);
    // Strip trailing slash/segments like /jobs
    const raw = m && m[1] && decodeURIComponent(m[1]).split('/')[0];
    if (raw) return raw;
  }
  return null;
}

export function detect(company) {
  for (const url of candidateUrls(company)) {
    const slug = matchSlug(url);
    if (slug) {
      return {
        slug,
        boardUrl: `https://join.com/companies/${encodeURIComponent(slug)}`,
      };
    }
  }
  return null;
}

function titleFromSlug(slug) {
  // "game-designer-us-market-f-m-d" -> "Game Designer Us Market F M D"
  return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
}

function isRemote(title, location) {
  const hay = `${title || ''} ${location || ''}`.toLowerCase();
  return /\bremote\b|\banywhere\b|work from home|\bwfh\b/.test(hay);
}

async function getHtml(url, ctx) {
  const fetchText = ctx?.fetchText;
  if (typeof fetchText === 'function') return fetchText(url);
  // Fallback to global fetch so the adapter still works standalone.
  const res = await fetch(url);
  return res.text();
}

// Extracts { items, pagination } from the page's embedded Next.js state.
function parseNextData(html) {
  const idx = html.indexOf('__NEXT_DATA__');
  if (idx < 0) return null;
  const start = html.indexOf('>', idx) + 1;
  const end = html.indexOf('</script>', start);
  if (start <= 0 || end < 0) return null;
  try {
    const data = JSON.parse(html.slice(start, end));
    const jobs = data?.props?.pageProps?.initialState?.jobs;
    if (!jobs || !Array.isArray(jobs.items)) return null;
    return { items: jobs.items, pagination: jobs.pagination || {} };
  } catch (_) {
    return null;
  }
}

function jobFromNextItem(item, slug) {
  const title = item.title || '';
  const location = [item.city?.cityName, item.city?.countryName].filter(Boolean).join(', ');
  const detailUrl = item.idParam
    ? `https://join.com/companies/${encodeURIComponent(slug)}/${item.idParam}`
    : `https://join.com/companies/${encodeURIComponent(slug)}`;
  return {
    title,
    detail_url: detailUrl,
    apply_url: detailUrl,
    location,
    remote: isRemote(title, location) || item.workplaceType === 'REMOTE',
    department: item.category?.name || '',
    posted_date: item.createdAt || '',
    employment_type: item.employmentType?.name || '',
    raw: item,
  };
}

// Safety ceiling on pages walked — join.com boards run small (single/double
// digit pages in this dataset), this is a generous guard against a runaway
// loop, not a tuned real-world cap.
const MAX_PAGES = 200;

async function fetchViaNextData(handle, ctx, firstHtml) {
  const first = parseNextData(firstHtml);
  if (!first) return null;
  const seen = new Map(); // job id -> job
  for (const item of first.items) seen.set(item.id, jobFromNextItem(item, handle.slug));

  const pageCount = Number(first.pagination?.pageCount) || 1;
  const lastPage = Math.min(pageCount, MAX_PAGES);
  for (let page = 2; page <= lastPage; page++) {
    const url = `${handle.boardUrl}?page=${page}`;
    let html;
    try {
      html = await getHtml(url, ctx);
    } catch (err) {
      if (ctx?.logWarn) ctx.logWarn(`join ${handle.slug}: page ${page} failed: ${err.message}`);
      break;
    }
    const parsed = parseNextData(html);
    if (!parsed || !parsed.items.length) break;
    for (const item of parsed.items) seen.set(item.id, jobFromNextItem(item, handle.slug));
  }
  if (pageCount > MAX_PAGES && ctx?.logWarn) {
    ctx.logWarn(`join ${handle.slug}: board reports ${pageCount} pages, capped walk at ${MAX_PAGES}`);
  }
  return Array.from(seen.values());
}

export async function fetchJobs(handle, ctx) {
  if (!handle?.boardUrl) return [];
  try {
    const html = await getHtml(handle.boardUrl, ctx);
    if (!html || typeof html !== 'string') return [];

    // Preferred path: walk the real, verified `?page=N` pagination exposed
    // via the embedded Next.js state (see header comment for the bug this
    // replaced).
    const viaNextData = await fetchViaNextData(handle, ctx, html);
    if (viaNextData) return viaNextData;

    // Fallback A: JSON-LD JobPosting blocks (single page only — used when
    // __NEXT_DATA__ is absent, which in practice means no pagination info
    // is available either).
    const jsonLd = [];
    const ldRe = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
    let ldm;
    while ((ldm = ldRe.exec(html))) {
      try {
        for (const node of [].concat(JSON.parse(ldm[1]))) {
          if (node && node['@type'] === 'JobPosting') jsonLd.push(node);
        }
      } catch (_) { /* skip malformed */ }
    }
    if (jsonLd.length) {
      return jsonLd.map(n => {
        const title = n.title || '';
        const addr = (Array.isArray(n.jobLocation) ? n.jobLocation[0] : n.jobLocation)?.address;
        const location = [addr?.addressLocality, addr?.addressRegion, addr?.addressCountry].filter(Boolean).join(', ');
        const detailUrl = n.url || handle.boardUrl;
        return {
          title, detail_url: detailUrl, apply_url: detailUrl, location,
          remote: isRemote(title, location) || n.jobLocationType === 'TELECOMMUTE',
          department: n.industry || '',
          posted_date: n.datePosted || '',
          employment_type: Array.isArray(n.employmentType) ? n.employmentType.join(', ') : (n.employmentType || ''),
          raw: n,
        };
      });
    }

    // Fallback B: scrape anchor hrefs matching /companies/{slug}/{id}-{title}.
    const jobs = new Map();
    const escSlug = handle.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`/companies/${escSlug}/(\\d+)-([a-z0-9-]+)`, 'gi');
    let m;
    while ((m = re.exec(html))) {
      if (!jobs.has(m[1])) jobs.set(m[1], m[2]);
    }
    return Array.from(jobs.entries()).map(([id, jslug]) => {
      const title = titleFromSlug(jslug);
      const detailUrl = `https://join.com/companies/${encodeURIComponent(handle.slug)}/${id}-${jslug}`;
      return {
        title, detail_url: detailUrl, apply_url: detailUrl, location: '',
        remote: isRemote(title, ''), department: '', posted_date: '', employment_type: '',
        raw: { id, slug: jslug, source: 'html' },
      };
    });
  } catch (err) {
    if (ctx?.logWarn) ctx.logWarn(`join ${handle.slug}: ${err.message}`);
    return [];
  }
}
