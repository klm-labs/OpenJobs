// discover-greenhouse.mjs — discover + live-verify Greenhouse tenant slugs, self-contained.
//
// Same two-step technique as discover-ats-commoncrawl.mjs + verify-ats-candidates.mjs,
// replicated here for Greenhouse in one script (per instructions: don't touch the shared
// multi-platform scripts, keep this self-contained).
//
// STEP 1 — Discovery via Common Crawl:
//   Greenhouse job boards are served on `boards.greenhouse.io/{slug}` (legacy) and
//   `job-boards.greenhouse.io/{slug}` (current), per adapters/greenhouse.mjs's own
//   HOST_PATTERNS (which also lists .eu variants, rare in the wild — not queried here).
//   Common Crawl's URL index (index.commoncrawl.org) is queried for both host patterns,
//   walking every block of every recent crawl snapshot (see blockCount/fetchBlock below —
//   mirrors discover-ats-commoncrawl.mjs's collinfo/pagination handling). Greenhouse is
//   probably the most popular ATS in this space, so this is deliberately run over more
//   crawls than the other platforms to budget for a much larger result set.
//
// STEP 2 — Live verification:
//   Every candidate slug is checked against the real public API documented in
//   adapters/greenhouse.mjs: https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true
//   returns {jobs: [...]} for a valid slug. Unknown slugs 404. A 200 with the well-formed
//   {jobs: [...]} shape (even if jobs is currently empty) is trusted as a real tenant — but
//   we still require >=1 posting to keep the dataset useful, matching the bar the other
//   verifiers already set (breezy/lever/etc. all require >=1 posting too).
//
// Output: output/greenhouse-discovery-v2.json, same shape as output/{lever,breezy,...}-discovery-v2.json
//   { ats, generated_at, stats: {...}, companies: [...] }
//
// Usage:
//   node discover-greenhouse.mjs                    # full run: discover + verify
//   node discover-greenhouse.mjs --crawls 10         # more/fewer CC snapshots
//   node discover-greenhouse.mjs --limit 500         # cap candidates verified (testing)
//   node discover-greenhouse.mjs --use-cc-cache      # reuse output/cc-slugs-greenhouse.json, skip CC crawl
//   node discover-greenhouse.mjs --use-verify-cache  # reuse output/verified-raw-greenhouse.json, skip live API calls

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'output');
const CC_INDEX = 'https://index.commoncrawl.org';
const COLLINFO = `${CC_INDEX}/collinfo.json`;
const TIMEOUT_MS = 15000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const N_CRAWLS = Number(arg('crawls', 8)); // biggest platform → more snapshots than the 6 default used for others
const LIMIT = Number(arg('limit', 0)) || Infinity;
const USE_CC_CACHE = args.includes('--use-cc-cache');
const USE_VERIFY_CACHE = args.includes('--use-verify-cache');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Common Crawl patterns (mirrors discover-ats-commoncrawl.mjs's TARGETS) ────────
// Two host variants, per adapters/greenhouse.mjs's HOST_PATTERNS. Path-based tenant id
// (like Lever), not a subdomain.
const CC_TARGETS = [
  {
    pattern: 'boards.greenhouse.io/*',
    host: /^https?:\/\/boards\.greenhouse\.io\/([A-Za-z0-9][A-Za-z0-9_.-]{1,80})/i,
  },
  {
    pattern: 'job-boards.greenhouse.io/*',
    host: /^https?:\/\/job-boards\.greenhouse\.io\/([A-Za-z0-9][A-Za-z0-9_.-]{1,80})/i,
  },
];
// Non-tenant path segments (provider infra, static assets, generic API paths).
const RESERVED = new Set([
  'robots.txt', 'sitemap.xml', 'favicon.ico', 'embed', 'assets', 'static', 'img', 'images',
  'css', 'js', 'api', 'www', 'help', 'support', 'status', 'blog', 'docs', 'developer',
  'developers', 'about', 'privacy', 'terms', 'login', 'signup', 'admin', 'dashboard',
]);

// The CC index is frequently flaky under load (502/504/truncated bodies). Bounded retries
// with linear backoff; a truncated 200 (HTML error page instead of JSON) is treated as a
// failure too, same defensive check as discover-ats-commoncrawl.mjs.
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

// CC paginates by *block*. `showNumPages` with pageSize=1 gives the block count; each
// page=N then returns exactly one block (~3k URLs), small enough to come back reliably.
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

function harvestSlugs(ndjson, target, into) {
  for (const line of ndjson.split('\n')) {
    if (!line.startsWith('{')) continue;
    let u;
    try { u = JSON.parse(line).url; } catch { continue; }
    if (!u) continue;
    const m = u.match(target.host);
    if (!m) continue;
    const slug = decodeURIComponent(m[1]).toLowerCase();
    if (RESERVED.has(slug)) continue;
    if (slug.length < 2) continue;
    into.add(slug);
  }
}

async function discoverCC(crawls) {
  const slugs = new Set();
  for (const crawl of crawls) {
    for (const target of CC_TARGETS) {
      let blocks;
      try {
        blocks = await blockCount(crawl, target.pattern);
      } catch (e) {
        console.error(`  ${crawl} ${target.pattern}: block count failed (${e.message}) — skipping`);
        continue;
      }
      if (!blocks) { console.error(`  ${crawl} ${target.pattern}: 0 blocks`); continue; }
      const before = slugs.size;
      let ok = 0;
      for (let p = 0; p < blocks; p++) {
        try {
          harvestSlugs(await fetchBlock(crawl, target.pattern, p), target, slugs);
          ok++;
        } catch (e) {
          console.error(`  ${crawl} ${target.pattern} block ${p}: ${e.message}`);
        }
      }
      console.error(`  ${crawl} ${target.pattern}: ${ok}/${blocks} blocks → +${slugs.size - before} new (total ${slugs.size})`);
    }
  }
  return [...slugs].sort();
}

// ── HTTP with retry/backoff (mirrors verify-ats-candidates.mjs's req()) ────────────
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
async function req(url, { json = false, tries = 3, follow = true } = {}) {
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

function meta(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i');
  const m = html.match(re) || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'));
  return m ? decodeEntities(m[1]).trim() : '';
}
function titleOf(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}
function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#x27;/gi, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
const NON_SITE = /greenhouse\.io|linkedin|twitter|x\.com|facebook|instagram|youtube|tiktok|github\.com|glassdoor|w3\.org|schema\.org|googleapis|gstatic|amazonaws|cloudfront|google\.com|apple\.com|mailto:|javascript:|\.(png|jpg|jpeg|svg|gif|css|js|ico)(\?|$)/i;
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

// Greenhouse tenant-existence probe: the exact API adapters/greenhouse.mjs uses. Unknown
// slugs 404; a valid slug always 200s with { jobs: [...] } even when jobs is empty.
async function verifyGreenhouse(slug) {
  const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
  const r = await req(apiUrl, { json: true });
  if (r.status !== 200) return null;
  const j = parseJson(r.body);
  if (!j || !Array.isArray(j.jobs)) return null; // malformed / not a real board
  if (j.jobs.length === 0) return null; // require >=1 posting, same bar as breezy/lever verifiers

  const jobs = j.jobs.map(job => ({
    title: job.title || '',
    dept: job.departments?.[0]?.name || '',
    location: job.location?.name || '',
  }));

  // Board page for company name/website — job-boards.greenhouse.io is the current host,
  // boards.greenhouse.io (legacy) still works and redirects for many tenants.
  const boardUrl = `https://job-boards.greenhouse.io/${encodeURIComponent(slug)}`;
  const board = await req(boardUrl, { follow: true });
  const html = board.status === 200 ? board.body : '';
  const name = meta(html, 'og:site_name')
    || titleOf(html).replace(/\s*[-|–]\s*(jobs|careers?|job board).*$/i, '')
    || slug;

  return {
    jobs,
    name,
    website: extractWebsite(html),
    links: [boardUrl],
  };
}

// ── Classification & junk filtering (ported verbatim from verify-ats-candidates.mjs) ──
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
  'udvikler', 'programmør', 'kehittäjä', 'ohjelmistokehittäjä', 'ohjelmistosuunnittelija',
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

const BAD_NAME = /\b(demo|sandbox|test|training|implementation|dummy|example|template|staging)\b.*\b(account|company|env|environment|board|site|tenant|[0-9]+)\b|^(lever|greenhouse|workable|breezy|bamboohr|teamtailor)\b|\b(xml feed|rss feed|job feed|api feed|test company|your company here)\b/i;
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

// ── Existing-dataset index ─────────────────────────────────────────
const GH_SLUG_RE = /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/i;
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
      const m = String(u).match(GH_SLUG_RE);
      if (m) {
        const slug = decodeURIComponent(m[1]).toLowerCase();
        if (!['www', 'career', 'app', 'api'].includes(slug)) slugs.add(slug);
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
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Step 1: discovery via Common Crawl.
  const ccCacheFile = path.join(OUT_DIR, 'cc-slugs-greenhouse.json');
  let raw;
  let ccMeta = { crawls: [] };
  if (USE_CC_CACHE && fs.existsSync(ccCacheFile)) {
    const c = JSON.parse(fs.readFileSync(ccCacheFile, 'utf8'));
    raw = c.slugs;
    ccMeta.crawls = c.crawls || [];
    console.error(`[greenhouse] using cached CC slugs: ${raw.length} (${c.generated_at})`);
  } else {
    const crawls = await listCrawls(N_CRAWLS);
    ccMeta.crawls = crawls;
    console.error(`Crawls: ${crawls.join(', ')}\n`);
    console.error(`── greenhouse (boards.greenhouse.io/*, job-boards.greenhouse.io/*) over ${crawls.length} crawls`);
    raw = await discoverCC(crawls);
    fs.writeFileSync(ccCacheFile, JSON.stringify({
      ats: 'greenhouse', source: 'commoncrawl-url-index',
      patterns: CC_TARGETS.map(t => t.pattern),
      crawls, generated_at: new Date().toISOString(), count: raw.length, slugs: raw,
    }, null, 2));
    console.error(`  → ${raw.length} slugs → ${ccCacheFile}\n`);
  }

  // Step 2: drop known slugs, then live-verify the rest.
  const index = buildIndex();
  let cands = raw.filter(s => !index.slugs.has(s.toLowerCase()) && !BAD_SLUG.test(s));
  const stats = { sources: ['cc-slugs-greenhouse.json'], raw: raw.length, after_known_slug: cands.length };
  cands = cands.slice(0, LIMIT);

  const verifyCacheFile = path.join(OUT_DIR, 'verified-raw-greenhouse.json');
  let verified;
  if (USE_VERIFY_CACHE && fs.existsSync(verifyCacheFile)) {
    const c = JSON.parse(fs.readFileSync(verifyCacheFile, 'utf8'));
    verified = c.verified;
    stats.verified_from_cache = c.verified_at;
    console.error(`[greenhouse] ${stats.raw} raw → ${stats.after_known_slug} unknown slugs → ${verified.length} from cache (${c.verified_at})`);
  } else {
    const CONCURRENCY = 15; // central shared API — stay reasonably conservative, more tolerant than Lever
    console.error(`[greenhouse] ${stats.raw} raw → ${stats.after_known_slug} unknown slugs → verifying ${cands.length} (concurrency ${CONCURRENCY})`);
    verified = await pmap(cands, CONCURRENCY, async slug => {
      const v = await verifyGreenhouse(slug);
      return v ? { slug, ...v } : null;
    }, (d, n) => process.stderr.write(`\r  [greenhouse] ${d}/${n}`));
    process.stderr.write('\n');
    fs.writeFileSync(verifyCacheFile, JSON.stringify({ ats: 'greenhouse', verified_at: new Date().toISOString(), verified }));
  }
  stats.live_verified = verified.length;

  // Step 3-4: classify, dedupe, format.
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
        ats: 'greenhouse', slug: v.slug,
        source: 'commoncrawl-url-index',
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

  const out = path.join(OUT_DIR, 'greenhouse-discovery-v2.json');
  fs.writeFileSync(out, JSON.stringify({ ats: 'greenhouse', generated_at: new Date().toISOString(), stats, companies: records }, null, 2));
  console.error(`[greenhouse] verified ${stats.live_verified} | -${dropDup} dup | -${dropJunk} out-of-scope | → ${records.length} net-new → ${out}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
