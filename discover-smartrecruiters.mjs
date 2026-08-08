// discover-smartrecruiters.mjs — discover + live-verify SmartRecruiters tenants, self-contained.
//
// Same two-step technique proven for Lever/BambooHR/Teamtailor/Breezy
// (see discover-ats-commoncrawl.mjs and verify-ats-candidates.mjs), replicated here in one
// self-contained file for a single platform: SmartRecruiters.
//
// STEP 1 — DISCOVERY via Common Crawl:
//   adapters/smartrecruiters.mjs recognizes three tenant URL shapes:
//     careers.smartrecruiters.com/{slug}
//     jobs.smartrecruiters.com/{slug}
//     api.smartrecruiters.com/v1/companies/{slug}
//   `careers.smartrecruiters.com` now 301-redirects to `jobs.smartrecruiters.com` (SmartRecruiters
//   consolidated onto the `jobs.` host at some point), but `careers.` was the long-standing primary
//   domain for years, so historical crawls still carry plenty of `careers.` URLs even though the
//   live host redirects today — both patterns are queried and unioned. The `api.` host is not
//   meaningfully crawled (it's an API, not a linked page) so it is not queried against Common Crawl.
//   Both are single shared hosts with a path-based slug (like jobs.lever.co), not per-tenant
//   subdomains — the tenant is the first path segment.
//
// STEP 2 — LIVE VERIFICATION:
//   https://api.smartrecruiters.com/v1/companies/{slug}/postings?limit=100
//   GOTCHA (documented in adapters/smartrecruiters.mjs and probe-ats.mjs): this endpoint returns
//   HTTP 200 + {totalFound:0} for ANY slug, real or not — a 200 status alone proves nothing. Only
//   `totalFound > 0` counts as a verified tenant. Each posting's `company.name` field gives the
//   tenant's real display name for free, no extra board-page scrape required.
//
// Output: output/smartrecruiters-discovery-v2.json — same shape as output/lever-discovery-v2.json:
//   { ats, generated_at, stats: {...}, companies: [ {..company_v2 fields.., _discovery: {...}} ] }
//
// Usage:
//   node discover-smartrecruiters.mjs                  # full run: discover + verify
//   node discover-smartrecruiters.mjs --crawls 10       # widen the Common Crawl sweep
//   node discover-smartrecruiters.mjs --limit 200       # cap candidates verified (testing)
//   node discover-smartrecruiters.mjs --use-cache       # re-filter cached live results, no network
//   node discover-smartrecruiters.mjs --skip-discovery  # reuse output/cc-slugs-smartrecruiters.json

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'output');
const CC_INDEX = 'https://index.commoncrawl.org';
const COLLINFO = `${CC_INDEX}/collinfo.json`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const TIMEOUT_MS = 15000;

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const N_CRAWLS = Number(arg('crawls', 6));
const LIMIT = Number(arg('limit', 0)) || Infinity;
const USE_CACHE = args.includes('--use-cache');
const SKIP_DISCOVERY = args.includes('--skip-discovery');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Common Crawl URL index patterns for SmartRecruiters tenant boards ─
// Path-based (one shared host per pattern), not a subdomain — the tenant slug is the first
// path segment, same shape as jobs.lever.co.
const CC_PATTERNS = [
  { pattern: 'careers.smartrecruiters.com/*', host: /^https?:\/\/careers\.smartrecruiters\.com\/([A-Za-z0-9][A-Za-z0-9_.-]{1,80})/i },
  { pattern: 'jobs.smartrecruiters.com/*', host: /^https?:\/\/jobs\.smartrecruiters\.com\/([A-Za-z0-9][A-Za-z0-9_.-]{1,80})/i },
];
// Non-tenant path segments seen off these hosts (marketing/infra pages, not company boards).
const RESERVED = new Set([
  'robots.txt', 'sitemap.xml', 'favicon.ico', 'www', 'api', 'app', 'blog', 'help', 'status',
  'test', 'dev', 'demo', 'staging', 'stage', 'assets', 'static', 'cdn', 'media', 'images',
  'css', 'js', 'img', 'search', 'company', 'companies', 'job', 'jobs', 'career', 'careers',
  'about', 'login', 'signup', 'account', 'privacy', 'terms', 'support', 'contact',
]);

// ── HTTP with retry/backoff — Common Crawl side ────────────────────
// The CC index is frequently flaky under load (502/504/connection-refused/truncated bodies).
// Every call goes through this: bounded retries with linear backoff, and the caller
// re-validates the body shape so a truncated 200 is treated as a failure too.
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

// CC paginates by *block*. `showNumPages` with pageSize=1 gives the block count;
// each page=N then returns exactly one block (~3k URLs), which is small enough to
// come back reliably.
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

function harvestSlugs(ndjson, host, into) {
  for (const line of ndjson.split('\n')) {
    if (!line.startsWith('{')) continue;
    let u;
    try { u = JSON.parse(line).url; } catch { continue; }
    if (!u) continue;
    const m = u.match(host);
    if (!m) continue;
    const slug = decodeURIComponent(m[1]);
    const key = slug.toLowerCase();
    if (RESERVED.has(key)) continue;
    if (slug.length < 2) continue;
    into.add(slug);
  }
}

async function discoverPattern({ pattern, host }, crawls, slugs) {
  for (const crawl of crawls) {
    let blocks;
    try {
      blocks = await blockCount(crawl, pattern);
    } catch (e) {
      console.error(`  ${crawl} (${pattern}): block count failed (${e.message}) — skipping`);
      continue;
    }
    if (!blocks) { console.error(`  ${crawl} (${pattern}): 0 blocks`); continue; }
    const before = slugs.size;
    let ok = 0;
    for (let p = 0; p < blocks; p++) {
      try {
        harvestSlugs(await fetchBlock(crawl, pattern, p), host, slugs);
        ok++;
      } catch (e) {
        console.error(`  ${crawl} (${pattern}) block ${p}: ${e.message}`);
      }
    }
    console.error(`  ${crawl} (${pattern}): ${ok}/${blocks} blocks → +${slugs.size - before} new (total ${slugs.size})`);
  }
}

async function runDiscovery() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const crawls = await listCrawls(N_CRAWLS);
  console.error(`Crawls: ${crawls.join(', ')}\n`);
  const slugs = new Set();
  for (const target of CC_PATTERNS) {
    console.error(`── ${target.pattern} over ${crawls.length} crawls`);
    await discoverPattern(target, crawls, slugs);
  }
  // Dedup case-insensitively but keep the first-seen casing — SmartRecruiters company IDs are
  // case-sensitive in the API path, and the board's own casing (e.g. "PeopleCanFly") is what
  // resolves; a slug is not guaranteed to also resolve lowercased.
  const seen = new Map();
  for (const s of slugs) {
    const k = s.toLowerCase();
    if (!seen.has(k)) seen.set(k, s);
  }
  const out = [...seen.values()].sort();
  const outPath = path.join(OUT_DIR, 'cc-slugs-smartrecruiters.json');
  fs.writeFileSync(outPath, JSON.stringify({
    ats: 'smartrecruiters', source: 'commoncrawl-url-index',
    patterns: CC_PATTERNS.map(t => t.pattern), crawls,
    generated_at: new Date().toISOString(), count: out.length, slugs: out,
  }, null, 2));
  console.error(`  → ${out.length} slugs → ${outPath}\n`);
  return out;
}

// ── HTTP with retry/backoff — SmartRecruiters live API side ───────
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
      return { status: r.status, body };
    } catch {
      await sleep(1200 * (i + 1));
    }
  }
  return { status: 0, body: '' };
}
const parseJson = s => { try { return JSON.parse(s); } catch { return null; } };

// Live-verify one candidate slug against the real SmartRecruiters postings API.
// GOTCHA: HTTP 200 + {totalFound:0} comes back for ANY slug — real or made up — so status
// alone proves nothing. Only totalFound > 0 counts as a real, existing tenant. We pull
// up to 100 postings in one call both to sample job titles for classification and because
// content[].company.name gives the tenant's real display name for free.
async function verifySlug(slug) {
  const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=100`;
  const r = await req(url, { json: true });
  if (r.status !== 200) return null;
  const j = parseJson(r.body);
  if (!j || typeof j.totalFound !== 'number' || j.totalFound <= 0) return null;
  const content = Array.isArray(j.content) ? j.content : [];
  if (content.length === 0) return null;
  const jobs = content.map(p => ({
    title: p.name || '',
    dept: p.department?.label || p.function?.label || '',
    location: [p.location?.city, p.location?.region].filter(Boolean).join(', '),
    country: p.location?.country || '',
  }));
  const name = content.find(p => p.company?.name)?.company?.name || slug;
  return {
    jobs,
    name,
    website: '', // the postings API doesn't expose the tenant's own domain
    links: [`https://jobs.smartrecruiters.com/${encodeURIComponent(slug)}`],
    totalFound: j.totalFound,
  };
}

// ── Classification & junk filtering ────────────────────────────────
// Identical approach (and largely identical lexicon) to verify-ats-candidates.mjs: signals
// are matched as whole words/phrases, never substrings — an earlier version used
// String.includes() and 'api' happily matched "capital", "rapid" and "therapist", which
// dragged dental practices and staffing agencies into the dataset as "tech".
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
  // Non-English role words — SmartRecruiters is heavily used by large European/global
  // enterprises, so an English-only keyword list would silently drop real tech postings.
  'utvecklare', 'systemutvecklare', 'mjukvaruutvecklare', 'programmerare', 'utvikler',
  'udvikler', 'programmør', 'kehittäjä', 'ohjelmistokehittäjä', 'ohjelmistosuunnittelija',
  'entwickler', 'softwareentwickler', 'programmierer', 'développeur', 'developpeur',
  'ingénieur logiciel', 'ingenieur logiciel', 'desarrollador', 'desenvolvedor',
  'sviluppatore', 'ontwikkelaar', 'systemarkitekt', 'lösningsarkitekt', 'testautomatisering',
  'dataingenjör', 'datavetare', 'it-arkitekt', 'it-konsult', 'teknisk konsult',
]);
const TECH_NAME = rx(['software', 'technologies', 'technology', 'labs', 'lab', 'digital', 'systems', 'cyber', 'robotics', 'analytics', 'ai', 'saas', 'fintech', 'app', 'tech', 'data', 'cloud', 'semiconductor', 'biotech', 'aerospace', 'space']);

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
const BAD_NAME = /\b(demo|sandbox|test|training|implementation|dummy|example|template|staging)\b.*\b(account|company|env|environment|board|site|tenant|[0-9]+)\b|^(lever|greenhouse|workable|breezy|bamboohr|teamtailor|smartrecruiters)\b|\b(xml feed|rss feed|job feed|api feed|test company|your company here)\b/i;
const BAD_SLUG = /^(test|demo|sandbox|staging|example|sample|training|dummy|temp|qa|dev|foo|bar|acme)([-_0-9]|$)|(-test|-demo|-sandbox|-staging|-copy|-old|-backup)$|^[0-9a-f]{16,}$/i;

function classify(name, slug, jobs) {
  const nameHay = ` ${name} ${slug} `.toLowerCase().replace(/-/g, ' ');
  const jobHay = ' ' + jobs.slice(0, 80).map(j => `${j.title} ${j.dept}`).join(' | ').toLowerCase() + ' ';
  const hay = nameHay + jobHay;

  const gStrong = hits(hay, GAMING_STRONG);
  const gWeak = hits(hay, GAMING_WEAK);
  const tStrong = hits(hay, TECH_STRONG);
  const tName = hits(nameHay, TECH_NAME);
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
const SR_SLUG_RE = /(?:careers|jobs)\.smartrecruiters\.com\/([^/?#]+)|api\.smartrecruiters\.com\/v1\/companies\/([^/?#]+)/i;
const normName = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(inc|llc|ltd|limited|gmbh|ab|as|oy|bv|sa|srl|corp|co|company|studios?|games?|group|holdings?)$/g, '');
const domainOf = u => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };

function buildIndex() {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'companies_v2.json'), 'utf8'));
  const list = Array.isArray(data) ? data : (data.companies || data.data || []);
  const slugs = new Set(), names = new Set(), domains = new Set();
  for (const c of list) {
    if (c.name) names.add(normName(c.name));
    for (const u of [c.website, ...(c.ats_links || []), ...(c.list_urls || [])]) {
      if (!u) continue;
      const m = String(u).match(SR_SLUG_RE);
      if (m) {
        const slug = decodeURIComponent(m[1] || m[2]);
        if (!['www', 'api', 'careers', 'jobs'].includes(slug.toLowerCase())) slugs.add(slug.toLowerCase());
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
      if (onTick && ++done % 50 === 0) onTick(done, items.length);
    }
  }));
  return out.filter(Boolean);
}

// ── Main ───────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const slugFile = path.join(OUT_DIR, 'cc-slugs-smartrecruiters.json');
  let raw;
  if (SKIP_DISCOVERY && fs.existsSync(slugFile)) {
    raw = JSON.parse(fs.readFileSync(slugFile, 'utf8')).slugs || [];
    console.error(`[smartrecruiters] --skip-discovery: reusing ${raw.length} cached slugs from ${slugFile}\n`);
  } else {
    raw = await runDiscovery();
  }

  const index = buildIndex();
  let cands = raw.filter(s => !index.slugs.has(s.toLowerCase()) && !BAD_SLUG.test(s));
  const stats = { sources: ['cc-slugs-smartrecruiters.json'], raw: raw.length, after_known_slug: cands.length };
  cands = cands.slice(0, LIMIT);

  // The live sweep is the only expensive step, so its raw result is cached. Re-running with
  // --use-cache re-does dedup/classification/formatting for free, which is what you want when
  // tuning the filters; drop the flag (or delete the cache) to re-confirm against the live API.
  const cacheFile = path.join(OUT_DIR, 'verified-raw-smartrecruiters.json');
  let verified;
  if (USE_CACHE && fs.existsSync(cacheFile)) {
    const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    verified = c.verified;
    stats.verified_from_cache = c.verified_at;
    console.error(`[smartrecruiters] ${stats.raw} raw → ${stats.after_known_slug} unknown slugs → ${verified.length} from cache (${c.verified_at})`);
  } else {
    // Central shared host, no per-tenant subdomain — probe-ats.mjs caps SmartRecruiters
    // concurrency at 8 for the same reason; mirror that here rather than hammering one host.
    const CONCURRENCY = 8;
    console.error(`[smartrecruiters] ${stats.raw} raw → ${stats.after_known_slug} unknown slugs → verifying ${cands.length} (concurrency ${CONCURRENCY})`);
    verified = await pmap(cands, CONCURRENCY, async slug => {
      const v = await verifySlug(slug);
      return v ? { slug, ...v } : null;
    }, (d, n) => process.stderr.write(`\r  [smartrecruiters] ${d}/${n}`));
    process.stderr.write('\n');
    fs.writeFileSync(cacheFile, JSON.stringify({ ats: 'smartrecruiters', verified_at: new Date().toISOString(), verified }));
  }
  stats.live_verified = verified.length;

  const records = [];
  const seenName = new Set(), seenSlug = new Set();
  let dropDup = 0, dropJunk = 0;
  for (const v of verified) {
    const nn = normName(v.name);
    const slugKey = v.slug.toLowerCase();
    if ((nn && index.names.has(nn)) || (nn && seenName.has(nn)) || seenSlug.has(slugKey)) { dropDup++; continue; }
    if (BAD_NAME.test(v.name)) { dropJunk++; continue; }
    const cls = classify(v.name, v.slug, v.jobs);
    if (cls.drop) { dropJunk++; continue; }
    seenSlug.add(slugKey);
    if (nn) seenName.add(nn);
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
        ats: 'smartrecruiters', slug: v.slug,
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

  const out = path.join(OUT_DIR, 'smartrecruiters-discovery-v2.json');
  fs.writeFileSync(out, JSON.stringify({ ats: 'smartrecruiters', generated_at: new Date().toISOString(), stats, companies: records }, null, 2));
  console.error(`[smartrecruiters] verified ${stats.live_verified} | -${dropDup} dup | -${dropJunk} out-of-scope | → ${records.length} net-new → ${out}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
