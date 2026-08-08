// verify-ats-candidates.mjs — live-verify discovered ATS tenant slugs and emit companies_v2 records.
//
// Input:  output/cc-slugs-{breezy,teamtailor,bamboohr,lever}.json (discover-ats-commoncrawl.mjs)
//         output/gh-slugs-lever.json                              (discover-lever-github.mjs)
//         Lever's two sources are unioned; the others have one each.
// Output: output/{ats}-discovery-v2.json
//
// Pipeline per candidate slug:
//   1. Drop slugs already routed in data/companies_v2.json (by ATS slug).
//   2. Hit the SAME endpoint the corresponding adapter uses and require a real response.
//      All four ATSes cleanly reject unknown tenants (302 to the marketing site for
//      breezy/bamboohr, 404 for teamtailor, 404 for lever), so a valid 200 proves the
//      tenant exists. Verified 2026-08-08 against nonsense slugs.
//   3. Fetch the tenant's own name (and website, where the board page exposes it).
//   4. Drop by name/website against companies_v2.json (catches the same company tracked
//      under a different ATS).
//   5. Classify gaming vs tech and junk-filter, using the live job titles/departments we
//      already fetched in step 2 — no extra requests, and far more signal than the slug alone.
//
// Usage:
//   node verify-ats-candidates.mjs                 # all four
//   node verify-ats-candidates.mjs --ats breezy
//   node verify-ats-candidates.mjs --ats lever --limit 200
//   node verify-ats-candidates.mjs --use-cache   # re-filter cached live results, no network

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'output');
const TIMEOUT_MS = 15000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ONLY = arg('ats', null);
const LIMIT = Number(arg('limit', 0)) || Infinity;
// Reuse output/verified-raw-{ats}.json instead of re-hitting the live APIs (filter tuning).
const USE_CACHE = args.includes('--use-cache');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── HTTP with retry/backoff ────────────────────────────────────────
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

// `follow: false` (the default) is what proves tenant existence — unknown tenants redirect
// to the provider's marketing site, so we must NOT follow. Board/HTML scrapes pass
// follow: true because real tenants legitimately redirect to custom career domains.
async function req(url, { json = false, tries = 3, follow = false } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const r = await fetch(url, { signal: ctrl.signal, redirect: follow ? 'follow' : 'manual', headers: { 'user-agent': UA, accept: json ? 'application/json' : 'text/html' } });
      clearTimeout(t);
      if (RETRY_STATUS.has(r.status)) { await sleep(1500 * (i + 1)); continue; }
      const body = r.status >= 200 && r.status < 300 ? await r.text() : '';
      return { status: r.status, body, location: r.headers.get('location') || '' };
    } catch {
      await sleep(1200 * (i + 1));
    }
  }
  return { status: 0, body: '', location: '' };
}

const parseJson = s => { try { return JSON.parse(s); } catch { return null; } };

// Tenant-existence probe for the subdomain ATSes: a 200 means the tenant exists, and a
// redirect means it does NOT — *unless* the redirect goes somewhere other than the
// provider's own marketing site, which is how a tenant on a custom career domain behaves.
async function probeTenant(url, marketingRe) {
  const r = await req(url, { json: true });
  if (r.status === 200) return r;
  if (r.status >= 300 && r.status < 400 && r.location && !marketingRe.test(r.location)) {
    return req(url, { json: true, follow: true });
  }
  return { status: r.status, body: '', location: r.location };
}

function meta(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i');
  const m = html.match(re) || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'));
  return m ? decodeEntities(m[1]).trim() : '';
}
function titleOf(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/%DOC_TITLE%/g, '').replace(/\s+/g, ' ').trim() : '';
}
function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#x27;/gi, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

// Pull the company's own site out of a careers page: the logo/header link is the only
// external href that isn't the ATS, a social network, or a CDN.
const NON_SITE = /lever\.co|breezy\.hr|teamtailor|bamboohr|linkedin|twitter|x\.com|facebook|instagram|youtube|tiktok|github\.com|glassdoor|w3\.org|schema\.org|googleapis|gstatic|amazonaws|cloudfront|google\.com|apple\.com|mailto:|javascript:|\.(png|jpg|jpeg|svg|gif|css|js|ico)(\?|$)/i;
function extractWebsite(html) {
  const seen = new Map();
  for (const m of html.matchAll(/href=["'](https?:\/\/[^"'\s]+)["']/gi)) {
    const u = m[1];
    if (NON_SITE.test(u)) continue;
    let host;
    try { host = new URL(u).hostname.replace(/^www\./, ''); } catch { continue; }
    if (!host.includes('.') || host.split('.').length > 4) continue;
    seen.set(host, (seen.get(host) || 0) + 1);
  }
  if (!seen.size) return '';
  const [host] = [...seen.entries()].sort((a, b) => b[1] - a[1])[0];
  return `https://${host}`;
}

// ── Per-ATS verification ───────────────────────────────────────────
// Each returns null (not a real tenant) or { jobs:[{title,dept,location}], name, website, links }.

const VERIFIERS = {
  lever: {
    concurrency: 8, // central shared API — stay conservative
    async verify(slug) {
      const r = await req(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`, { json: true });
      if (r.status !== 200) return null;
      const j = parseJson(r.body);
      if (!Array.isArray(j) || j.length === 0) return null; // Lever 200s only for real boards; require postings
      const jobs = j.map(p => ({
        title: p.text || '',
        dept: p.categories?.team || p.categories?.department || '',
        location: p.categories?.location || '',
      }));
      const board = await req(`https://jobs.lever.co/${encodeURIComponent(slug)}`, { follow: true });
      return {
        jobs,
        name: titleOf(board.body) || meta(board.body, 'og:title').replace(/\s+jobs$/i, '') || slug,
        website: extractWebsite(board.body),
        links: [`https://jobs.lever.co/${slug}`],
      };
    },
  },

  bamboohr: {
    concurrency: 20, // per-tenant subdomain — no shared rate limit
    async verify(slug) {
      const r = await probeTenant(`https://${slug}.bamboohr.com/careers/list`, /^https?:\/\/(www\.)?bamboohr\.com\/?$/i);
      if (r.status !== 200) return null; // unknown tenants 302 to www.bamboohr.com
      const j = parseJson(r.body);
      if (!j || !Array.isArray(j.result)) return null;
      const jobs = j.result
        .filter(x => String(x.jobOpeningStatus || x.status || '').toLowerCase() !== 'closed')
        .map(x => ({
          title: x.jobOpeningName || '',
          dept: x.departmentLabel || '',
          location: [x.location?.city, x.location?.state, x.atsLocation?.country].filter(Boolean).join(', '),
        }));
      if (jobs.length === 0) return null;
      // BambooHR exposes the tenant's real display name here; the careers page is a JS shell.
      const info = await req(`https://${slug}.bamboohr.com/careers/company-info`, { json: true });
      const name = parseJson(info.body)?.result?.name || slug;
      return { jobs, name, website: '', links: [`https://${slug}.bamboohr.com/careers`] };
    },
  },

  breezy: {
    concurrency: 20,
    async verify(slug) {
      const r = await probeTenant(`https://${slug}.breezy.hr/json`, /^https?:\/\/(www\.)?breezy\.hr\/?$/i);
      // Unknown Breezy subdomains 302 to breezy.hr, so a 200 confirms a real tenant even
      // when the array is empty. We still require >=1 posting to keep the dataset useful.
      if (r.status !== 200) return null;
      const j = parseJson(r.body);
      if (!Array.isArray(j) || j.length === 0) return null;
      const jobs = j.map(p => ({
        title: p.name || '',
        dept: typeof p.department === 'string' ? p.department : (p.department?.name || ''),
        location: p.location?.name || [p.location?.city, p.location?.country?.name].filter(Boolean).join(', '),
        country: p.location?.country?.name || '',
      }));
      const board = await req(`https://${slug}.breezy.hr/`, { follow: true });
      return {
        jobs,
        name: titleOf(board.body) || slug,
        website: extractWebsite(board.body),
        links: [`https://${slug}.breezy.hr/`],
      };
    },
  },

  teamtailor: {
    concurrency: 15,
    async verify(slug) {
      // Unknown tenants 404. Real tenants either 200 or 301 to their own career domain
      // (still a Teamtailor-rendered page), so follow redirects here.
      const r = await req(`https://${slug}.teamtailor.com/jobs`, { follow: true });
      if (r.status !== 200 || !r.body || r.body.length < 500) return null;
      const html = r.body;
      const jobs = [];
      const seen = new Set();
      for (const m of html.matchAll(/<a\b[^>]*href="(https?:\/\/[^"]*\/jobs\/\d+[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
        const [, href, inner] = m;
        if (seen.has(href)) continue;
        seen.add(href);
        const titled = inner.match(/<span[^>]*title="([^"]+)"/i);
        const title = titled ? decodeEntities(titled[1]) : decodeEntities(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
        if (title) jobs.push({ title, dept: '', location: '' });
      }
      if (jobs.length === 0) return null;
      return {
        jobs,
        name: meta(html, 'og:site_name') || titleOf(html).replace(/\s*[-|–]\s*(jobs|careers?).*$/i, '') || slug,
        website: extractWebsite(html),
        links: [`https://${slug}.teamtailor.com/jobs`],
      };
    },
  },
};

// ── Classification & junk filtering ────────────────────────────────

// Signals are matched as whole words/phrases, never substrings — an earlier version used
// String.includes() and 'api' happily matched "capital", "rapid" and "therapist", which
// dragged dental practices and staffing agencies into the dataset as "tech".
const rx = words => new RegExp(`(?:^|[^a-z0-9])(?:${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?:$|[^a-z0-9])`, 'gi');
const hits = (hay, re) => { re.lastIndex = 0; const s = new Set(); let m; while ((m = re.exec(hay))) { s.add(m[0].trim()); re.lastIndex = Math.max(re.lastIndex - 1, 0); } return s.size; };

// Unambiguous games-industry roles/tech. One of these is enough to call a company gaming.
const GAMING_STRONG = rx([
  'game designer', 'game developer', 'game engineer', 'game programmer', 'game producer',
  'game artist', 'game director', 'gameplay', 'game design', 'game development',
  'unity', 'unity3d', 'unreal', 'unreal engine', 'godot', 'cocos',
  'level designer', 'level design', 'technical artist', 'character artist', 'concept artist',
  'environment artist', 'narrative designer', 'narrative design', 'vfx artist',
  'esports', 'e-sports', 'igaming', 'sportsbook', 'slot game', 'slot games', 'casino games',
  'game studio', 'game studios', 'liveops', 'live ops', 'roblox', 'game qa', 'game tester',
  'interactive entertainment', 'video game', 'video games', 'mobile games', 'aaa',
]);
// Suggestive but ambiguous ("studio", "3d artist" also fit ad agencies).
const GAMING_WEAK = rx(['game', 'games', 'gaming', 'gamedev', 'studio', 'studios', '3d artist', '3d animator', 'animator', 'metaverse', 'casino', 'betting', 'rigging', 'shader']);

// Concrete software/technology roles. Deliberately role-phrases, not bare tech nouns.
const TECH_STRONG = rx([
  'software engineer', 'software developer', 'software architect', 'backend engineer',
  'back-end engineer', 'backend developer', 'frontend engineer', 'front-end engineer',
  'frontend developer', 'front-end developer', 'full stack', 'full-stack', 'fullstack',
  'web developer', 'mobile developer', 'ios developer', 'android developer',
  'devops', 'dev ops', 'sre', 'site reliability', 'platform engineer', 'cloud engineer',
  'infrastructure engineer', 'systems engineer', 'network engineer', 'security engineer',
  'cybersecurity', 'data engineer', 'data scientist', 'machine learning', 'ml engineer',
  'ai engineer', 'ai researcher', 'nlp engineer', 'computer vision', 'qa engineer',
  'test engineer', 'automation engineer', 'solutions architect', 'engineering manager',
  'vp of engineering', 'head of engineering', 'cto', 'chief technology officer',
  'product manager', 'product designer', 'ux designer', 'ui designer', 'ux/ui', 'ui/ux',
  'python developer', 'java developer', 'javascript developer', 'react developer',
  '.net developer', 'php developer', 'golang', 'rust developer', 'node.js', 'nodejs',
  'kubernetes', 'terraform', 'salesforce developer', 'embedded engineer', 'firmware engineer',
  'blockchain', 'smart contract', 'technical lead', 'tech lead', 'principal engineer',
  'staff engineer', 'developer relations', 'developer advocate', 'analytics engineer',
  'database administrator', 'sql developer', 'integration engineer', 'api engineer',
  'integration specialist', 'solution consultant', 'solutions consultant', 'it consultant',
  'software consultant', 'erp consultant', 'sap consultant', 'atlassian', 'salesforce',
  'system administrator', 'systems administrator', 'product owner', 'scrum master',
  'data analyst', 'bi developer', 'sharepoint', 'azure', 'aws', 'gcp',
  // Non-English role words. Teamtailor in particular is Nordic-heavy and an English-only
  // keyword list silently dropped real software firms whose postings are in Swedish/Finnish.
  'utvecklare', 'systemutvecklare', 'mjukvaruutvecklare', 'programmerare', 'utvikler',
  'udvikler', 'programmør', 'kehittäjä', 'ohjelmistokehittäjä', 'ohjelmistosuunnittelija',
  'entwickler', 'softwareentwickler', 'programmierer', 'développeur', 'developpeur',
  'ingénieur logiciel', 'ingenieur logiciel', 'desarrollador', 'desenvolvedor',
  'sviluppatore', 'ontwikkelaar', 'systemarkitekt', 'lösningsarkitekt', 'testautomatisering',
  'dataingenjör', 'datavetare', 'it-arkitekt', 'it-konsult', 'teknisk konsult',
]);
// Company-name / domain signals for tech-ish businesses with non-technical job titles.
const TECH_NAME = rx(['software', 'technologies', 'technology', 'labs', 'lab', 'digital', 'systems', 'cyber', 'robotics', 'analytics', 'ai', 'saas', 'fintech', 'app', 'tech', 'data', 'cloud', 'semiconductor', 'biotech', 'aerospace', 'space']);
const TECH_TLD = /\.(io|ai|dev|tech|app|xyz|sh|so)$/i;

// Out-of-scope industries this dataset does not track.
const JUNK = rx([
  'dental', 'dentist', 'orthodontic', 'hygienist', 'plumber', 'plumbing', 'hvac',
  'roofing', 'roofer', 'landscaping', 'landscaper', 'restaurant', 'brewery', 'barista',
  'salon', 'spa', 'church', 'ministry', 'pastor', 'worship', 'daycare', 'preschool',
  'nursing', 'caregiver', 'home care', 'home health', 'cna', 'lpn', 'rn', 'medical assistant',
  'phlebotomist', 'truck driver', 'cdl', 'freight', 'janitorial', 'housekeeping', 'custodian',
  'electrician', 'veterinary', 'veterinarian', 'chiropractic', 'real estate agent',
  'insurance agent', 'paralegal', 'attorney', 'physical therapist', 'physical therapy',
  'occupational therapy', 'dispensary', 'cannabis', 'budtender', 'funeral', 'auto repair',
  'automotive technician', 'hotel', 'housekeeper', 'line cook', 'dishwasher', 'server',
  'welder', 'machinist', 'carpenter', 'concrete', 'hairstylist', 'barber', 'massage therapist',
  'escort', 'webcam', 'laborer', 'warehouse associate', 'retail associate', 'cashier',
  'security guard', 'painter', 'flooring', 'pest control', 'lawn care', 'teacher',
  'substitute', 'tutor', 'social worker', 'case manager', 'counselor', 'therapist',
  'pharmacy technician', 'dietitian', 'paramedic', 'firefighter', 'crossing guard',
]);

// Display names that reveal a non-company tenant: the ATS vendor's own demo/training
// boards, and internal feed/system boards that carry a real slug but aren't an employer.
const BAD_NAME = /\b(demo|sandbox|test|training|implementation|dummy|example|template|staging)\b.*\b(account|company|env|environment|board|site|tenant|[0-9]+)\b|^(lever|greenhouse|workable|breezy|bamboohr|teamtailor)\b|\b(xml feed|rss feed|job feed|api feed|test company|your company here)\b/i;

// Non-company tenants (sandboxes, agencies' own demo boards, etc.).
const BAD_SLUG = /^(test|demo|sandbox|staging|example|sample|training|dummy|temp|qa|dev|foo|bar|acme)([-_0-9]|$)|(-test|-demo|-sandbox|-staging|-copy|-old|-backup)$|^[0-9a-f]{16,}$/i;

function classify(name, slug, website, jobs) {
  const nameHay = ` ${name} ${slug} `.toLowerCase().replace(/-/g, ' ');
  const jobHay = ' ' + jobs.slice(0, 80).map(j => `${j.title} ${j.dept}`).join(' | ').toLowerCase() + ' ';
  const hay = nameHay + jobHay;

  const gStrong = hits(hay, GAMING_STRONG);
  const gWeak = hits(hay, GAMING_WEAK);
  const tStrong = hits(hay, TECH_STRONG);
  const tName = hits(nameHay, TECH_NAME) + (TECH_TLD.test(domainOf(website)) ? 1 : 0);
  const junk = hits(jobHay, JUNK);

  const g = gStrong * 2 + gWeak;
  const t = tStrong * 2 + tName;

  // A business whose postings look mostly like an out-of-scope industry is dropped unless
  // the in-scope signal clearly outweighs it (e.g. a health-tech firm hiring engineers).
  if (junk > 0 && tStrong < junk && gStrong === 0) return { drop: true };
  // Nothing in-scope at all.
  if (gStrong === 0 && tStrong === 0 && g < 2 && tName === 0) return { drop: true };

  // Two or more unambiguous games signals means a games company even when the board is
  // dominated by generic engineering roles (which is normal for a large studio).
  const type = gStrong >= 2 || (gStrong >= 1 && g >= t) || g >= 4 ? 'gaming' : 'tech';
  return { drop: false, type, gaming_score: g, tech_score: t, junk_score: junk };
}

function countriesOf(jobs) {
  const set = new Set();
  for (const j of jobs) {
    const c = (j.country || '').trim();
    if (c) set.add(c);
  }
  return [...set].slice(0, 8);
}

// ── Existing-dataset index ─────────────────────────────────────────
const SLUG_PATTERNS = {
  lever: /jobs(?:\.eu)?\.lever\.co\/([A-Za-z0-9_.-]+)/i,
  bamboohr: /([a-z0-9_-]+)\.bamboohr\.com/i,
  breezy: /([a-z0-9_-]+)\.breezy\.hr/i,
  teamtailor: /([a-z0-9_-]+)\.teamtailor\.com/i,
};
const normName = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(inc|llc|ltd|limited|gmbh|ab|as|oy|bv|sa|srl|corp|co|company|studios?|games?|group|holdings?)$/g, '');
const domainOf = u => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };

function buildIndex() {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'companies_v2.json'), 'utf8'));
  const slugs = Object.fromEntries(Object.keys(SLUG_PATTERNS).map(k => [k, new Set()]));
  const names = new Set(), domains = new Set();
  for (const c of data) {
    if (c.name) names.add(normName(c.name));
    for (const u of [c.website, ...(c.ats_links || []), ...(c.list_urls || [])]) {
      if (!u) continue;
      for (const [ats, re] of Object.entries(SLUG_PATTERNS)) {
        const m = String(u).match(re);
        if (m && !['www', 'career', 'app', 'api'].includes(m[1].toLowerCase())) slugs[ats].add(m[1].toLowerCase());
      }
      if (u === c.website) { const d = domainOf(u); if (d) domains.add(d); }
    }
  }
  return { slugs, names, domains };
}

// ── Bounded-concurrency map ────────────────────────────────────────
async function pmap(items, limit, fn, onTick) {
  const out = [];
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out.push(await fn(items[idx])); } catch { /* ignore */ }
      if (onTick && ++done % 100 === 0) onTick(done, items.length);
    }
  }));
  return out.filter(Boolean);
}

// ── Main ───────────────────────────────────────────────────────────
// Lever has two independent slug sources (historical Common Crawl + GitHub code search);
// they overlap only partially, so we union them.
const SOURCES = {
  lever: ['cc-slugs-lever.json', 'gh-slugs-lever.json'],
  bamboohr: ['cc-slugs-bamboohr.json'],
  breezy: ['cc-slugs-breezy.json'],
  teamtailor: ['cc-slugs-teamtailor.json'],
};

async function run(ats, index) {
  const union = new Set();
  const used = [];
  for (const f of SOURCES[ats]) {
    const src = path.join(OUT_DIR, f);
    if (!fs.existsSync(src)) continue;
    for (const s of JSON.parse(fs.readFileSync(src, 'utf8')).slugs || []) union.add(s.toLowerCase());
    used.push(f);
  }
  if (!used.length) { console.error(`[${ats}] no slug source in output/ (${SOURCES[ats].join(', ')}) — run the discovery script first`); return; }
  const raw = [...union];

  const known = index.slugs[ats];
  let cands = raw.filter(s => !known.has(s.toLowerCase()) && !BAD_SLUG.test(s));
  const stats = { sources: used, raw: raw.length, after_known_slug: cands.length };
  cands = cands.slice(0, LIMIT);

  // The live sweep is the only expensive step, so its raw result is cached. Re-running with
  // --use-cache re-does dedup/classification/formatting for free, which is what you want when
  // tuning the filters; drop the flag (or delete the cache) to re-confirm against the live APIs.
  const cacheFile = path.join(OUT_DIR, `verified-raw-${ats}.json`);
  let verified;
  if (USE_CACHE && fs.existsSync(cacheFile)) {
    const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    verified = c.verified;
    stats.verified_from_cache = c.verified_at;
    console.error(`[${ats}] ${stats.raw} raw → ${stats.after_known_slug} unknown slugs → ${verified.length} from cache (${c.verified_at})`);
  } else {
    console.error(`[${ats}] ${stats.raw} raw → ${stats.after_known_slug} unknown slugs → verifying ${cands.length} (concurrency ${VERIFIERS[ats].concurrency})`);
    verified = await pmap(cands, VERIFIERS[ats].concurrency, async slug => {
      const v = await VERIFIERS[ats].verify(slug);
      return v ? { slug, ...v } : null;
    }, (d, n) => process.stderr.write(`\r  [${ats}] ${d}/${n}`));
    process.stderr.write('\n');
    fs.writeFileSync(cacheFile, JSON.stringify({ ats, verified_at: new Date().toISOString(), verified }));
  }
  stats.live_verified = verified.length;

  const records = [];
  const seenName = new Set(), seenDomain = new Set();
  let dropDup = 0, dropJunk = 0;
  for (const v of verified) {
    const nn = normName(v.name);
    const dom = domainOf(v.website);
    if ((nn && index.names.has(nn)) || (dom && index.domains.has(dom))) { dropDup++; continue; }
    if ((nn && seenName.has(nn)) || (dom && seenDomain.has(dom))) { dropDup++; continue; }
    if (BAD_NAME.test(v.name)) { dropJunk++; continue; }
    const cls = classify(v.name, v.slug, v.website, v.jobs);
    if (cls.drop) { dropJunk++; continue; }
    if (nn) seenName.add(nn);
    if (dom) seenDomain.add(dom);
    records.push({
      name: v.name,
      website: v.website || '',
      industry_category: cls.type,
      type: cls.type,
      game_genre: [],
      tech_stack: [],
      ats_links: v.links,
      list_urls: v.links,
      countries: countriesOf(v.jobs),
      _discovery: {
        ats, slug: v.slug,
        source: ats === 'lever' ? 'github-code-search' : 'commoncrawl-url-index',
        verified_at: new Date().toISOString(),
        job_count: v.jobs.length,
        sample_titles: v.jobs.slice(0, 3).map(j => j.title),
        gaming_score: cls.gaming_score, tech_score: cls.tech_score,
      },
    });
  }
  stats.dropped_duplicate = dropDup;
  stats.dropped_out_of_scope = dropJunk;
  stats.net_new = records.length;

  const out = path.join(OUT_DIR, `${ats}-discovery-v2.json`);
  fs.writeFileSync(out, JSON.stringify({ ats, generated_at: new Date().toISOString(), stats, companies: records }, null, 2));
  console.error(`[${ats}] verified ${stats.live_verified} | -${dropDup} dup | -${dropJunk} out-of-scope | → ${records.length} net-new → ${out}\n`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const index = buildIndex();
  for (const ats of (ONLY ? [ONLY] : Object.keys(SOURCES))) await run(ats, index);
}

main().catch(e => { console.error(e); process.exit(1); });
