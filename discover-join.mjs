// discover-join.mjs — discover and verify Join.com tenant slugs via Common Crawl + live verification.
//
// Join.com is PATH-based like Lever (single shared host `join.com/companies/{slug}`, not subdomain).
// robots.txt does NOT block crawlers (verified 2026-08-08), so we use recent Common Crawl data.
//
// Pipeline:
//   1. Query Common Crawl URL index for `join.com/companies/*`
//   2. Extract slugs (path segment after /companies/), dedupe
//   3. Drop slugs already routed in data/companies_v2.json
//   4. Live-verify each by fetching https://join.com/companies/{slug} and confirming real job data
//      using the extraction logic from adapters/join.mjs (Next.js __NEXT_DATA__, JSON-LD, or HTML anchors)
//   5. Extract company name from live data
//   6. Classify gaming vs. tech using live job titles/departments
//   7. Output output/join-discovery-v2.json in the exact shape of lever-discovery-v2.json
//
// Usage:
//   node discover-join.mjs                    # discover from CC, verify live (requires CC network access)
//   node discover-join.mjs --use-cache        # re-filter cached results, no network
//   node discover-join.mjs --limit 100        # cap verification to first 100
//   node discover-join.mjs --slugs-file <path> # use custom slug file (CC unreachable fallback)

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'output');
const TIMEOUT_MS = 15000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const CC_INDEX = 'https://index.commoncrawl.org';
const COLLINFO = `${CC_INDEX}/collinfo.json`;

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const LIMIT = Number(arg('limit', 0)) || Infinity;
const USE_CACHE = args.includes('--use-cache');
const CUSTOM_SLUGS = arg('slugs-file', null);
const N_CRAWLS = Number(arg('crawls', 6));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const parseJson = s => { try { return JSON.parse(s); } catch { return null; } };

// ── Common Crawl querying ──────────────────────────────────────

async function ccFetch(url, { tries = 5, timeoutMs = 240000 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'open-jobs-discovery/1.0' } });
      clearTimeout(t);
      const body = await r.text();
      if (r.ok && !body.startsWith('<')) return body;
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(3000 * (i + 1));
  }
  throw lastErr || new Error('ccFetch failed');
}

async function listCrawls(n) {
  const body = await ccFetch(COLLINFO, { timeoutMs: 60000 });
  return JSON.parse(body).slice(0, n).map(c => c.id);
}

async function blockCount(crawl, pattern) {
  const url = `${CC_INDEX}/${crawl}-index?url=${encodeURIComponent(pattern)}&output=json&showNumPages=true&pageSize=1`;
  const body = await ccFetch(url, { timeoutMs: 120000 });
  const j = JSON.parse(body);
  return Number(j.blocks || j.pages || 0);
}

async function fetchBlock(crawl, pattern, page) {
  const url = `${CC_INDEX}/${crawl}-index?url=${encodeURIComponent(pattern)}&output=json&fl=url&pageSize=1&page=${page}`;
  return ccFetch(url);
}

function harvestSlugs(ndjson, into) {
  for (const line of ndjson.split('\n')) {
    if (!line.startsWith('{')) continue;
    let u;
    try { u = JSON.parse(line).url; } catch { continue; }
    if (!u) continue;
    const m = u.match(/join\.com\/companies\/([^/?#]+)/i);
    if (!m) continue;
    const slug = decodeURIComponent(m[1]).split('/')[0].toLowerCase();
    if (slug.length < 2) continue;
    into.add(slug);
  }
}

async function discoverSlugs(crawls) {
  const pattern = 'join.com/companies/*';
  const slugs = new Set();
  for (const crawl of crawls) {
    let blocks;
    try {
      blocks = await blockCount(crawl, pattern);
    } catch (e) {
      console.error(`  ${crawl}: block count failed (${e.message}) — skipping`);
      continue;
    }
    if (!blocks) { console.error(`  ${crawl}: 0 blocks`); continue; }
    const before = slugs.size;
    let ok = 0;
    for (let p = 0; p < blocks; p++) {
      try {
        harvestSlugs(await fetchBlock(crawl, pattern, p), slugs);
        ok++;
      } catch (e) {
        console.error(`  ${crawl} block ${p}: ${e.message}`);
      }
    }
    console.error(`  ${crawl}: ${ok}/${blocks} blocks → +${slugs.size - before} new (total ${slugs.size})`);
  }
  return [...slugs].sort();
}

// ── HTTP with retry/backoff ────────────────────────────────────

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

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

// ── HTML parsing helpers ───────────────────────────────────────

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

const NON_SITE = /join\.com|linkedin|twitter|x\.com|facebook|instagram|youtube|tiktok|github\.com|glassdoor|w3\.org|schema\.org|googleapis|gstatic|amazonaws|cloudfront|google\.com|apple\.com|mailto:|javascript:|\.(png|jpg|jpeg|svg|gif|css|js|ico)(\?|$)/i;

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

// ── Join.com extraction (from adapters/join.mjs) ─────────────

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

function extractJobsFromNext(nextData) {
  if (!nextData || !Array.isArray(nextData.items)) return [];
  return nextData.items.map(item => ({
    title: item.title || '',
    dept: item.category?.name || '',
    location: [item.city?.cityName, item.city?.countryName].filter(Boolean).join(', '),
    country: item.city?.countryName || '',
  }));
}

function extractJobsFromJsonLd(html) {
  const jobs = [];
  const ldRe = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let ldm;
  while ((ldm = ldRe.exec(html))) {
    try {
      for (const node of [].concat(JSON.parse(ldm[1]))) {
        if (node && node['@type'] === 'JobPosting') {
          const addr = (Array.isArray(node.jobLocation) ? node.jobLocation[0] : node.jobLocation)?.address;
          const location = [addr?.addressLocality, addr?.addressRegion, addr?.addressCountry].filter(Boolean).join(', ');
          jobs.push({
            title: node.title || '',
            dept: node.industry || '',
            location,
            country: addr?.addressCountry || '',
          });
        }
      }
    } catch (_) { }
  }
  return jobs;
}

function extractJobsFromHtml(html, slug) {
  const jobs = new Map();
  const escSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`/companies/${escSlug}/(\\d+)-([a-z0-9-]+)`, 'gi');
  let m;
  while ((m = re.exec(html))) {
    if (!jobs.has(m[1])) {
      const title = m[2].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
      jobs.set(m[1], { title, dept: '', location: '', country: '' });
    }
  }
  return Array.from(jobs.values());
}

async function verifySlug(slug) {
  const boardUrl = `https://join.com/companies/${encodeURIComponent(slug)}`;
  const r = await req(boardUrl, { follow: true });
  if (r.status !== 200 || !r.body || r.body.length < 200) return null;

  const html = r.body;
  let jobs = [];

  const nextData = parseNextData(html);
  if (nextData) {
    jobs = extractJobsFromNext(nextData);
    if (jobs.length > 0) {
      return {
        jobs,
        name: titleOf(html) || slug,
        website: extractWebsite(html),
        links: [boardUrl],
      };
    }
  }

  jobs = extractJobsFromJsonLd(html);
  if (jobs.length > 0) {
    return {
      jobs,
      name: meta(html, 'og:site_name') || titleOf(html) || slug,
      website: extractWebsite(html),
      links: [boardUrl],
    };
  }

  jobs = extractJobsFromHtml(html, slug);
  if (jobs.length > 0) {
    return {
      jobs,
      name: titleOf(html) || slug,
      website: extractWebsite(html),
      links: [boardUrl],
    };
  }

  return null;
}

// ── Classification & filtering ─────────────────────────────────

const rx = words => new RegExp(`(?:^|[^a-z0-9])(?:${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?:$|[^a-z0-9])`, 'gi');
const hits = (hay, re) => { re.lastIndex = 0; const s = new Set(); let m; while ((m = re.exec(hay))) { s.add(m[0].trim()); re.lastIndex = Math.max(re.lastIndex - 1, 0); } return s.size; };

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
const GAMING_WEAK = rx(['game', 'games', 'gaming', 'gamedev', 'studio', 'studios', '3d artist', '3d animator', 'animator', 'metaverse', 'casino', 'betting', 'rigging', 'shader']);

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
  'utvecklare', 'systemutvecklare', 'mjukvaruutvecklare', 'programmerare', 'utvikler',
  'utvecklare', 'programmerare', 'utvecklare', 'utvecklare', 'utvecklare',
  'entwickler', 'softwareentwickler', 'programmierer', 'développeur', 'developpeur',
  'ingénieur logiciel', 'ingenieur logiciel', 'desarrollador', 'desenvolvedor',
  'sviluppatore', 'ontwikkelaar', 'systemarkitekt', 'lösningsarkitekt', 'testautomatisering',
  'dataingenjör', 'datavetare', 'it-arkitekt', 'it-konsult', 'teknisk konsult',
]);
const TECH_NAME = rx(['software', 'technologies', 'technology', 'labs', 'lab', 'digital', 'systems', 'cyber', 'robotics', 'analytics', 'ai', 'saas', 'fintech', 'app', 'tech', 'data', 'cloud', 'semiconductor', 'biotech', 'aerospace', 'space']);
const TECH_TLD = /\.(io|ai|dev|tech|app|xyz|sh|so)$/i;

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

const BAD_NAME = /\b(demo|sandbox|test|training|implementation|dummy|example|template|staging)\b.*\b(account|company|env|environment|board|site|tenant|[0-9]+)\b|^(lever|greenhouse|workable|breezy|bamboohr|teamtailor|join)\b|\b(xml feed|rss feed|job feed|api feed|test company|your company here)\b/i;

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

  if (junk > 0 && tStrong < junk && gStrong === 0) return { drop: true };
  if (gStrong === 0 && tStrong === 0 && g < 2 && tName === 0) return { drop: true };

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

// ── Existing-dataset index ─────────────────────────────────────

const normName = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(inc|llc|ltd|limited|gmbh|ab|as|oy|bv|sa|srl|corp|co|company|studios?|games?|group|holdings?)$/g, '');
const domainOf = u => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };

function buildIndex() {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'companies_v2.json'), 'utf8'));
  const slugs = new Set();
  const names = new Set(), domains = new Set();
  for (const c of data) {
    if (c.name) names.add(normName(c.name));
    for (const u of [c.website, ...(c.ats_links || []), ...(c.list_urls || [])]) {
      if (!u) continue;
      const m = String(u).match(/join\.com\/companies\/([^/?#]+)/i);
      if (m) {
        const slug = decodeURIComponent(m[1]).split('/')[0].toLowerCase();
        slugs.add(slug);
      }
      if (u === c.website) { const d = domainOf(u); if (d) domains.add(d); }
    }
  }
  return { slugs, names, domains };
}

// ── Bounded-concurrency map ────────────────────────────────────

async function pmap(items, limit, fn, onTick) {
  const out = [];
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out.push(await fn(items[idx])); } catch { }
      if (onTick && ++done % 100 === 0) onTick(done, items.length);
    }
  }));
  return out.filter(Boolean);
}

// ── Main ───────────────────────────────────────────────────────

async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const index = buildIndex();

  let rawSlugs = [];
  let source = 'commoncrawl-url-index';
  const stats = { sources: ['commoncrawl-url-index'], raw: 0, after_known_slug: 0 };

  // Discovery phase: query Common Crawl or use fallback
  if (CUSTOM_SLUGS) {
    console.error(`Loading custom slug file: ${CUSTOM_SLUGS}`);
    const customData = JSON.parse(fs.readFileSync(CUSTOM_SLUGS, 'utf8'));
    rawSlugs = customData.slugs || [];
    source = 'custom-file';
    stats.sources = ['custom-file'];
  } else {
    console.error('── join (join.com/companies/*) over recent crawls');
    try {
      const crawls = await listCrawls(N_CRAWLS);
      console.error(`Crawls: ${crawls.join(', ')}\n`);
      rawSlugs = await discoverSlugs(crawls);
      console.error(`\n  → ${rawSlugs.length} total slugs discovered\n`);
    } catch (e) {
      console.error(`\nCommon Crawl index unreachable: ${e.message}`);
      console.error(`To complete discovery, either:`);
      console.error(`  1. Run in an environment with Common Crawl access`);
      console.error(`  2. Use --slugs-file <path> with a pre-downloaded slug list from CC`);
      console.error(`  3. Use --use-cache if verified-raw-join.json already exists\n`);
      if (!USE_CACHE || !fs.existsSync(path.join(OUT_DIR, 'verified-raw-join.json'))) {
        console.error('No cached verification data available. Exiting.\n');
        process.exit(1);
      }
    }
  }

  // Filter: remove known slugs and bad candidates
  const known = index.slugs;
  let cands = rawSlugs.filter(s => !known.has(s) && !BAD_SLUG.test(s));
  stats.raw = rawSlugs.length;
  stats.after_known_slug = cands.length;
  cands = cands.slice(0, LIMIT);

  // Verification phase (use cache if available)
  const cacheFile = path.join(OUT_DIR, 'verified-raw-join.json');
  let verified;
  if (USE_CACHE && fs.existsSync(cacheFile)) {
    const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    verified = c.verified;
    stats.verified_from_cache = c.verified_at;
    console.error(`[join] ${stats.raw} raw → ${stats.after_known_slug} unknown slugs → ${verified.length} from cache (${c.verified_at})`);
  } else if (cands.length > 0) {
    console.error(`[join] ${stats.raw} raw → ${stats.after_known_slug} unknown slugs → verifying ${cands.length} (concurrency 10)`);
    verified = await pmap(cands, 10, async slug => {
      const v = await verifySlug(slug);
      return v ? { slug, ...v } : null;
    }, (d, n) => process.stderr.write(`\r  [join] ${d}/${n}`));
    process.stderr.write('\n');
    fs.writeFileSync(cacheFile, JSON.stringify({ ats: 'join', verified_at: new Date().toISOString(), verified }));
  } else {
    verified = [];
  }
  stats.live_verified = verified.length;

  // Classification & output
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
        ats: 'join',
        slug: v.slug,
        source,
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

  const out = path.join(OUT_DIR, 'join-discovery-v2.json');
  fs.writeFileSync(out, JSON.stringify({ ats: 'join', generated_at: new Date().toISOString(), stats, companies: records }, null, 2));
  console.error(`[join] verified ${stats.live_verified} | -${dropDup} dup | -${dropJunk} out-of-scope | → ${records.length} net-new → ${out}\n`);
}

run().catch(e => { console.error(e); process.exit(1); });
