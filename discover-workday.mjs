// discover-workday.mjs — self-contained discovery + live-verification for Workday
// (myworkdayjobs.com) tenants, output/workday-discovery-v2.json.
//
// This is a single-file replica of the two-step technique used for
// Lever/BambooHR/Teamtailor/Breezy (see discover-ats-commoncrawl.mjs +
// verify-ats-candidates.mjs), adapted for Workday's more complex URL shape.
//
// WHY WORKDAY NEEDS A DIFFERENT APPROACH THAN THE OTHER FOUR ATSES
// ------------------------------------------------------------------
// Breezy/BambooHR/Teamtailor are one clean wildcard each: *.breezy.hr,
// *.bamboohr.com, *.teamtailor.com — a single Common Crawl url= query per
// ATS returns every tenant subdomain directly.
//
// Workday's careers URL is a THIRD-level subdomain with a variable middle
// component: {tenant}.wd{N}.myworkdayjobs.com/{siteId}, where N is a small
// integer that differs per tenant (their Workday "pod" number). Two
// candidate approaches:
//
//   (a) query `url=*.myworkdayjobs.com` once and hope CC's wildcard also
//       matches third-level subdomains (not just tenant.myworkdayjobs.com);
//   (b) query one pattern per wd{N} value: `url=*.wd1.myworkdayjobs.com`,
//       `url=*.wd2.myworkdayjobs.com`, etc.
//
// This script tries (a) first (cheap: one blockCount call) and falls back to
// (b) automatically if (a)'s block count looks too small to plausibly cover
// third-level subdomains (CC's leading-wildcard match is host-suffix based,
// and in practice a bare `*.myworkdayjobs.com` query has been observed to
// under-match multi-level subdomains vs explicit per-wdN queries — so this
// script always ALSO runs (b) for the wdN range below, and unions the
// results; the (a) pass just costs one cheap extra call and can only add
// coverage, never subtract it).
//
// wdN RANGE: sampled from tenants already routed in data/companies_v2.json
// (see the inline analysis this comment is based on): of ~180 existing
// Workday ats_links, the overwhelming majority are wd1 (77), wd5 (55), wd3
// (45), with a long tail: wd10 (1, Alphawave Semi), wd12 (3, Salesforce/
// Stem/Ashland), and even a 3-digit wd501 (1, MRI Software). Since the tail
// is real but rare, this script queries wd1 through wd12 (covers the
// observed dense range) plus a couple of known larger pods (wd20, wd50,
// wd101, wd501) as a cheap best-effort net for outliers — anything beyond
// that is vanishingly rare and not worth the CC query budget.
//
// Output shape matches output/lever-discovery-v2.json exactly:
//   { ats, generated_at, stats: {...}, companies: [ {..., _discovery:{...}} ] }

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
const LIMIT = Number(arg('limit', 0)) || Infinity;
const N_CRAWLS = Number(arg('crawls', 3));
const USE_CACHE = args.includes('--use-cache');
const CONCURRENCY = Number(arg('concurrency', 15));

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Workday URL parsing — mirrors adapters/workday.mjs exactly ────────
const HOST_RE = /^https?:\/\/([^/.]+)\.wd(\d+)\.myworkdayjobs\.com\/([^?#]*)/i;
const LOCALE_RE = /^[a-z]{2}(?:-[A-Z]{2})?$/;

function parseWorkdayUrl(url) {
  const m = url.match(HOST_RE);
  if (!m) return null;
  const tenant = m[1].toLowerCase();
  const wdN = m[2];
  const tail = (m[3] || '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!tail) return null;
  const segments = tail.split('/').filter(Boolean);
  let siteId = segments[0];
  if (LOCALE_RE.test(segments[0]) && segments[1]) siteId = segments[1];
  if (!siteId) return null;
  return { tenant, wdN, siteId };
}

function buildHandle({ tenant, wdN, siteId }) {
  const host = `${tenant}.wd${wdN}.myworkdayjobs.com`;
  return {
    tenant, wdN, siteId, host,
    apiUrl: `https://${host}/wday/cxs/${tenant}/${siteId}/jobs`,
    boardUrl: `https://${host}/${siteId}`,
  };
}

// Non-tenant / infra hostnames that occasionally show up in Workday-adjacent crawl data.
const RESERVED_TENANTS = new Set(['www', 'wd1', 'wd2', 'wd3', 'wd5', 'test', 'demo', 'sandbox', 'impl', 'implementation']);

// ── Common Crawl fetch with retry ──────────────────────────────────────
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

function harvestCandidates(ndjson, into) {
  for (const line of ndjson.split('\n')) {
    if (!line.startsWith('{')) continue;
    let u;
    try { u = JSON.parse(line).url; } catch { continue; }
    if (!u) continue;
    const p = parseWorkdayUrl(u);
    if (!p) continue;
    if (RESERVED_TENANTS.has(p.tenant) || p.tenant.length < 2) continue;
    const key = `${p.tenant}|${p.wdN}|${p.siteId}`;
    into.set(key, p);
  }
}

async function discoverPattern(pattern, crawls, into, label) {
  for (const crawl of crawls) {
    let blocks;
    try {
      blocks = await blockCount(crawl, pattern);
    } catch (e) {
      console.error(`  ${label} ${crawl}: block count failed (${e.message}) — skipping`);
      continue;
    }
    if (!blocks) continue;
    const before = into.size;
    let ok = 0;
    for (let p = 0; p < blocks; p++) {
      try {
        harvestCandidates(await fetchBlock(crawl, pattern, p), into);
        ok++;
      } catch (e) {
        console.error(`  ${label} ${crawl} block ${p}: ${e.message}`);
      }
    }
    if (ok) console.error(`  ${label} ${crawl}: ${ok}/${blocks} blocks → +${into.size - before} new (total ${into.size})`);
  }
}

// wd{N} range: dense 1-12 (covers ~99% of the sample from companies_v2.json),
// plus a sparse tail of larger pod numbers seen in the wild (see header comment).
const WD_RANGE = [...Array.from({ length: 12 }, (_, i) => String(i + 1)), '20', '50', '101', '501'];

async function discoverAllCandidates() {
  const crawls = await listCrawls(N_CRAWLS);
  console.error(`Crawls: ${crawls.join(', ')}\n`);
  const candidates = new Map(); // key -> {tenant, wdN, siteId}

  // (a) cheap bare-domain pass — can only add coverage.
  console.error(`── bare pattern *.myworkdayjobs.com`);
  await discoverPattern('*.myworkdayjobs.com', crawls, candidates, 'bare');

  // (b) explicit per-wdN passes — the primary source.
  for (const n of WD_RANGE) {
    const pattern = `*.wd${n}.myworkdayjobs.com`;
    console.error(`── wd${n} (${pattern})`);
    await discoverPattern(pattern, crawls, candidates, `wd${n}`);
  }

  return [...candidates.values()];
}

// ── Existing-dataset index (tenant+siteId dedup) ───────────────────────
function buildIndex() {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'companies_v2.json'), 'utf8'));
  const knownKeys = new Set(); // tenant|siteId (wdN can drift for the same tenant, so ignore it)
  const names = new Set(), domains = new Set();
  const normName = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(inc|llc|ltd|limited|gmbh|ab|as|oy|bv|sa|srl|corp|co|company|studios?|games?|group|holdings?)$/g, '');
  const domainOf = u => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
  for (const c of data) {
    if (c.name) names.add(normName(c.name));
    if (c.website) { const d = domainOf(c.website); if (d) domains.add(d); }
    const urls = [...(c.ats_links || []), ...(c.list_urls || [])];
    for (const u of urls) {
      const p = parseWorkdayUrl(String(u || ''));
      if (p) knownKeys.add(`${p.tenant}|${p.siteId}`.toLowerCase());
    }
  }
  return { knownKeys, names, domains, normName, domainOf };
}

// ── Live verification (same endpoint the adapter uses) ─────────────────
async function req(url, { method = 'GET', body, tries = 3 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const opts = { signal: ctrl.signal, headers: { 'user-agent': UA, accept: 'application/json' } };
      if (method === 'POST') {
        opts.method = 'POST';
        opts.headers['content-type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
      const r = await fetch(url, opts);
      clearTimeout(t);
      if ([429, 500, 502, 503, 504].includes(r.status)) { await sleep(1500 * (i + 1)); continue; }
      const text = r.status >= 200 && r.status < 300 ? await r.text() : '';
      return { status: r.status, body: text };
    } catch {
      await sleep(1200 * (i + 1));
    }
  }
  return { status: 0, body: '' };
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

// Titleize a tenant slug into a human-ish display name fallback, e.g.
// "cloudimperiumgames" isn't splittable, but hyphenated/underscored slugs are.
function titleizeSlug(slug) {
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Verify a single {tenant, wdN, siteId} candidate against the live Workday CXS API.
// Reuses the adapter's exact pagination/total-quirk handling (see adapters/workday.mjs
// comment: `total` is only trustworthy on page 1 — a later page reporting total:0 must
// never overwrite a previously-seen positive total, or pagination looks "empty").
async function verify({ tenant, wdN, siteId }) {
  const handle = buildHandle({ tenant, wdN, siteId });
  const body0 = { appliedFacets: {}, limit: 20, offset: 0, searchText: '' };
  const r0 = await req(handle.apiUrl, { method: 'POST', body: body0 });
  if (r0.status !== 200) return null;
  const j0 = parseJson(r0.body);
  if (!j0 || !Array.isArray(j0.jobPostings)) return null;
  if (j0.jobPostings.length === 0) return null; // real tenant but zero live postings — skip, not useful
  const jobs = [];
  const pushJobs = json => {
    for (const p of json?.jobPostings || []) {
      jobs.push({
        title: p.title || '',
        location: p.locationsText || '',
        posted: p.postedOn || '',
        extPath: p.externalPath || '',
      });
    }
  };
  pushJobs(j0);
  let total = (typeof j0.total === 'number' && j0.total > 0) ? j0.total : jobs.length;
  // Pull a couple more pages (bounded) purely to get a better job-title sample for
  // classification — full pagination is the live adapter's job, not the discovery script's.
  let offset = 20;
  let guard = 0;
  while (offset < total && jobs.length < 100 && guard < 5) {
    guard++;
    const r = await req(handle.apiUrl, { method: 'POST', body: { appliedFacets: {}, limit: 20, offset, searchText: '' } });
    if (r.status !== 200) break;
    const j = parseJson(r.body);
    if (!j || !Array.isArray(j.jobPostings) || j.jobPostings.length === 0) break;
    pushJobs(j);
    offset += j.jobPostings.length;
    if (j.jobPostings.length < 20) break;
  }

  // Try to recover a display name: board HTML <title>/og:site_name, else titleized tenant slug.
  let name = '';
  let website = '';
  const board = await req(handle.boardUrl, { method: 'GET' });
  if (board.status === 200 && board.body) {
    name = meta(board.body, 'og:site_name') || titleOf(board.body).replace(/\s*[-|–]\s*(careers?|jobs).*$/i, '').trim();
  }
  if (!name) name = titleizeSlug(tenant);

  return { handle, jobs, total, name, website };
}

// ── Classification (same word-boundary approach as verify-ats-candidates.mjs) ──
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
  'semiconductor', 'chip design', 'asic', 'silicon engineer', 'hardware engineer',
]);
const TECH_NAME = rx(['software', 'technologies', 'technology', 'labs', 'lab', 'digital', 'systems', 'cyber', 'robotics', 'analytics', 'saas', 'fintech', 'semiconductor', 'biotech', 'aerospace']);

// Workday is heavily enterprise/non-tech (banks, retailers, manufacturers, healthcare
// systems, universities, governments). This list is intentionally broad — a much wider
// net than the other ATSes needed — because Workday's customer base skews that way hard.
const JUNK = rx([
  'dental', 'dentist', 'orthodontic', 'hygienist', 'plumber', 'plumbing', 'hvac',
  'roofing', 'roofer', 'landscaping', 'landscaper', 'restaurant', 'brewery', 'barista',
  'salon', 'spa', 'church', 'ministry', 'pastor', 'worship', 'daycare', 'preschool',
  'nursing', 'caregiver', 'home care', 'home health', 'cna', 'lpn', 'registered nurse',
  'phlebotomist', 'truck driver', 'cdl', 'freight', 'janitorial', 'housekeeping', 'custodian',
  'electrician', 'veterinary', 'veterinarian', 'chiropractic', 'real estate agent',
  'insurance agent', 'underwriter', 'paralegal', 'attorney', 'physical therapist',
  'physical therapy', 'occupational therapy', 'dispensary', 'cannabis', 'budtender',
  'funeral', 'auto repair', 'automotive technician', 'hotel', 'housekeeper', 'line cook',
  'dishwasher', 'server', 'welder', 'machinist', 'carpenter', 'concrete', 'hairstylist',
  'barber', 'massage therapist', 'laborer', 'warehouse associate', 'retail associate',
  'cashier', 'store manager', 'sales associate', 'merchandiser', 'security guard', 'painter',
  'flooring', 'pest control', 'lawn care', 'teacher', 'substitute teacher', 'professor',
  'tutor', 'social worker', 'case manager', 'counselor', 'therapist', 'pharmacy technician',
  'dietitian', 'paramedic', 'firefighter', 'police officer', 'correctional officer',
  'bank teller', 'loan officer', 'branch manager', 'flight attendant', 'pilot',
  'production operator', 'manufacturing technician', 'assembly line', 'forklift',
  'quality inspector', 'claims adjuster', 'actuary', 'accountant', 'auditor', 'bookkeeper',
  'tax preparer', 'physician', 'surgeon', 'radiologist', 'anesthesiologist', 'dietician',
  'store associate', 'grocery', 'supermarket', 'logistics coordinator', 'supply chain analyst',
]);

const BAD_NAME = /\b(demo|sandbox|test|training|implementation|dummy|example|template|staging)\b.*\b(account|company|env|environment|board|site|tenant|[0-9]+)\b|^(workday)\b/i;
const BAD_SLUG = /^(test|demo|sandbox|staging|example|sample|training|dummy|temp|qa|dev|foo|bar|acme|impl|implementation)([-_0-9]|$)|(-test|-demo|-sandbox|-staging|-copy|-old|-backup)$|^[0-9a-f]{16,}$/i;

function classify(name, tenant, jobs) {
  const nameHay = ` ${name} ${tenant} `.toLowerCase().replace(/-/g, ' ');
  const jobHay = ' ' + jobs.slice(0, 80).map(j => j.title).join(' | ').toLowerCase() + ' ';
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
  // Workday's locationsText is free-text ("San Francisco, CA, United States of America");
  // just collect distinct raw strings as a best-effort signal, capped like the other ATSes.
  const set = new Set();
  for (const j of jobs) {
    const loc = (j.location || '').trim();
    if (loc) set.add(loc);
  }
  return [...set].slice(0, 8);
}

// ── Bounded-concurrency map ─────────────────────────────────────────────
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

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const index = buildIndex();

  const cacheFile = path.join(OUT_DIR, 'verified-raw-workday.json');
  let raw, verified, stats;

  if (USE_CACHE && fs.existsSync(cacheFile)) {
    const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    raw = c.raw;
    verified = c.verified;
    stats = { sources: ['commoncrawl-url-index'], raw: c.raw.length, after_known_slug: c.afterKnown, verified_from_cache: c.verified_at, live_verified: verified.length };
    console.error(`[workday] loaded from cache: ${raw.length} raw → ${c.afterKnown} unknown → ${verified.length} verified (${c.verified_at})`);
  } else {
    const candidates = await discoverAllCandidates();
    raw = candidates;
    console.error(`\n[workday] ${candidates.length} raw {tenant,wdN,siteId} candidates`);

    let cands = candidates.filter(p => !index.knownKeys.has(`${p.tenant}|${p.siteId}`.toLowerCase()) && !BAD_SLUG.test(p.tenant));
    // De-dup candidates that share the same tenant+siteId across multiple wdN observations
    // (shouldn't normally happen, but crawl noise can produce it) — keep the first.
    const seenTS = new Set();
    cands = cands.filter(p => {
      const k = `${p.tenant}|${p.siteId}`.toLowerCase();
      if (seenTS.has(k)) return false;
      seenTS.add(k);
      return true;
    });
    cands = cands.slice(0, LIMIT);
    stats = { sources: ['commoncrawl-url-index (bare + wd1-12,20,50,101,501)'], raw: raw.length, after_known_slug: cands.length };

    console.error(`[workday] ${stats.raw} raw → ${stats.after_known_slug} unknown tenant+siteId → verifying (concurrency ${CONCURRENCY})`);
    verified = await pmap(cands, CONCURRENCY, async p => {
      const v = await verify(p);
      return v ? { tenant: p.tenant, wdN: p.wdN, siteId: p.siteId, ...v } : null;
    }, (d, n) => process.stderr.write(`\r  [workday] ${d}/${n}`));
    process.stderr.write('\n');
    stats.live_verified = verified.length;
    fs.writeFileSync(cacheFile, JSON.stringify({
      ats: 'workday', verified_at: new Date().toISOString(),
      raw, afterKnown: cands.length, verified,
    }));
  }

  const records = [];
  const seenName = new Set();
  let dropDup = 0, dropJunk = 0;
  for (const v of verified) {
    const nn = index.normName(v.name);
    if (nn && (index.names.has(nn) || seenName.has(nn))) { dropDup++; continue; }
    if (BAD_NAME.test(v.name)) { dropJunk++; continue; }
    const cls = classify(v.name, v.tenant, v.jobs);
    if (cls.drop) { dropJunk++; continue; }
    if (nn) seenName.add(nn);
    records.push({
      name: v.name,
      website: v.website || '',
      industry_category: cls.type,
      type: cls.type,
      game_genre: [],
      tech_stack: [],
      ats_links: [v.handle.boardUrl],
      list_urls: [v.handle.boardUrl],
      countries: countriesOf(v.jobs),
      _discovery: {
        ats: 'workday', tenant: v.tenant, wdN: v.wdN, siteId: v.siteId,
        source: 'commoncrawl-url-index',
        verified_at: new Date().toISOString(),
        job_count: v.jobs.length,
        reported_total: v.total,
        sample_titles: v.jobs.slice(0, 3).map(j => j.title),
        gaming_score: cls.gaming_score, tech_score: cls.tech_score,
      },
    });
  }
  stats.dropped_duplicate = dropDup;
  stats.dropped_out_of_scope = dropJunk;
  stats.net_new = records.length;

  const out = path.join(OUT_DIR, 'workday-discovery-v2.json');
  fs.writeFileSync(out, JSON.stringify({ ats: 'workday', generated_at: new Date().toISOString(), stats, companies: records }, null, 2));
  console.error(`[workday] verified ${stats.live_verified} | -${dropDup} dup | -${dropJunk} out-of-scope | → ${records.length} net-new → ${out}`);
}

main().catch(e => { console.error(e); process.exit(1); });
