// discover-ats-commoncrawl.mjs — enumerate ATS tenant slugs from the Common Crawl URL index.
//
// WHY THIS AND NOT CERTIFICATE TRANSPARENCY:
//   The obvious idea is to mine CT logs (crt.sh / Cert Spotter) for {slug}.bamboohr.com,
//   {slug}.breezy.hr, {slug}.teamtailor.com. This DOES NOT WORK: all three providers serve
//   every tenant off a single wildcard certificate (*.bamboohr.com, *.breezy.hr,
//   *.teamtailor.com), so no per-tenant certificate is ever issued and CT logs contain only
//   the provider's own infrastructure hostnames (~50-100 names, zero customers).
//   Verified 2026-08-08 against both crt.sh and api.certspotter.com.
//
//   Common Crawl's URL index, by contrast, is a queryable record of every URL its crawler has
//   actually fetched — including tenant careers pages, which are public and linked from company
//   sites. Querying `url=*.breezy.hr` returns thousands of real tenant hostnames.
//
// LEVER: jobs.lever.co is path-based (one shared host) and its robots.txt NOW blocks crawlers —
//   recent crawls contain a single indexed URL for it. But the block is recent: crawls from
//   ~2023 and earlier indexed jobs.lever.co heavily, and a company that had a Lever board then
//   very often still does (the verify pass discards the ones that don't). So Lever uses its own
//   HISTORICAL crawl list instead of the recent one. Pair this with discover-lever-github.mjs;
//   verify-ats-candidates.mjs unions both slug sources.
//
// Output: output/cc-slugs-{ats}.json  → { ats, crawls, generated_at, slugs: [...] }
//
// Usage:
//   node discover-ats-commoncrawl.mjs                       # all 3 ATSes, 6 recent crawls
//   node discover-ats-commoncrawl.mjs --ats breezy
//   node discover-ats-commoncrawl.mjs --crawls 10

import fs from 'node:fs';
import path from 'node:path';

const CC_INDEX = 'https://index.commoncrawl.org';
const COLLINFO = `${CC_INDEX}/collinfo.json`;

// Per-ATS: the CC url query pattern, and how to pull a tenant slug out of a matched URL.
const TARGETS = {
  breezy: {
    pattern: '*.breezy.hr',
    host: /^https?:\/\/([a-z0-9_-]+)\.breezy\.hr/i,
    // Provider infrastructure / non-tenant hostnames.
    reserved: new Set([
      'www', 'app', 'api', 'blog', 'help', 'status', 'test', 'dev', 'development',
      'staging', 'stage', 'demo', 'marketing', 'resources', 'lp', 'fp', 'jenkins',
      'perform', 'onboard', 'onboarding', 'sys', 'console', 'developer', 'webflow',
      'cdn', 'assets', 'static', 'media', 'images', 'mail', 'email', 'go', 'info',
    ]),
  },
  teamtailor: {
    pattern: '*.teamtailor.com',
    host: /^https?:\/\/([a-z0-9_-]+)\.teamtailor\.com/i,
    reserved: new Set([
      'www', 'app', 'api', 'blog', 'help', 'status', 'test', 'dev', 'demo',
      'career', 'career2', 'careers', 'dashboard', 'docs', 'discover', 'partner',
      'resources', 'highlights', 'integrations', 'assets', 'cdn', 'ember', 'fonts',
      'scripts', 'media', 'images', 'errors', 'auth', 'hello', 'na', 'eu2', 'au',
      'ext', 'e', 'mail', 'email', 'support', 'go', 'stage', 'staging',
    ]),
  },
  bamboohr: {
    pattern: '*.bamboohr.com',
    host: /^https?:\/\/([a-z0-9_-]+)\.bamboohr\.com/i,
    reserved: new Set([
      'www', 'app', 'api', 'blog', 'help', 'status', 'test', 'dev', 'demo',
      'community', 'benefits', 'calendar', 'developer', 'resources', 'marketplace',
      'partners', 'partnertrust', 'analytics', 'email', 'mail', 'go', 'info',
      'support', 'signup', 'login', 'assets', 'cdn', 'static', 'media', 'images',
      'stage', 'staging', 'restore3', 'restore4', 'restore7', 'advantagedemo',
    ]),
  },
  lever: {
    pattern: 'jobs.lever.co/*',
    // Path-based, not a subdomain: the tenant is the first path segment.
    host: /^https?:\/\/jobs(?:\.eu)?\.lever\.co\/([A-Za-z0-9][A-Za-z0-9_.-]{1,60})/i,
    reserved: new Set([
      'robots.txt', 'sitemap.xml', 'favicon.ico', 'apply', 'jobs', 'postings',
      'static', 'assets', 'img', 'images', 'css', 'js', 'api', 'www',
    ]),
    // Recent crawls are robots-blocked; these predate the block.
    crawls: [
      'CC-MAIN-2023-40', 'CC-MAIN-2023-23', 'CC-MAIN-2023-06',
      'CC-MAIN-2022-40', 'CC-MAIN-2022-21', 'CC-MAIN-2022-05',
      'CC-MAIN-2021-43', 'CC-MAIN-2021-25', 'CC-MAIN-2021-04',
      'CC-MAIN-2020-45', 'CC-MAIN-2020-24',
    ],
  },
};

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}

const ONLY = arg('ats', null);
const N_CRAWLS = Number(arg('crawls', 6));
const OUT_DIR = path.join(process.cwd(), 'output');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// The CC index is frequently flaky under load (502/504/truncated bodies). Every call
// goes through this: bounded retries with linear backoff, and the caller re-validates
// the body shape so a truncated 200 is treated as a failure too.
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

function harvestSlugs(ndjson, target, into) {
  for (const line of ndjson.split('\n')) {
    if (!line.startsWith('{')) continue;
    let u;
    try { u = JSON.parse(line).url; } catch { continue; }
    if (!u) continue;
    const m = u.match(target.host);
    if (!m) continue;
    const slug = m[1].toLowerCase();
    if (target.reserved.has(slug)) continue;
    // Single-char and pure-numeric hosts are almost never real tenants.
    if (slug.length < 2) continue;
    into.add(slug);
  }
}

async function discover(ats, crawls) {
  const target = TARGETS[ats];
  const slugs = new Set();
  for (const crawl of crawls) {
    let blocks;
    try {
      blocks = await blockCount(crawl, target.pattern);
    } catch (e) {
      console.error(`  ${crawl}: block count failed (${e.message}) — skipping`);
      continue;
    }
    if (!blocks) { console.error(`  ${crawl}: 0 blocks`); continue; }
    const before = slugs.size;
    let ok = 0;
    for (let p = 0; p < blocks; p++) {
      try {
        harvestSlugs(await fetchBlock(crawl, target.pattern, p), target, slugs);
        ok++;
      } catch (e) {
        console.error(`  ${crawl} block ${p}: ${e.message}`);
      }
    }
    console.error(`  ${crawl}: ${ok}/${blocks} blocks → +${slugs.size - before} new (total ${slugs.size})`);
  }
  return [...slugs].sort();
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const crawls = await listCrawls(N_CRAWLS);
  console.error(`Crawls: ${crawls.join(', ')}\n`);

  const list = ONLY ? [ONLY] : Object.keys(TARGETS);
  for (const ats of list) {
    if (!TARGETS[ats]) { console.error(`unknown ats: ${ats}`); continue; }
    // Lever pins its own historical crawl list (see header note).
    const useCrawls = TARGETS[ats].crawls || crawls;
    console.error(`── ${ats} (${TARGETS[ats].pattern}) over ${useCrawls.length} crawls`);
    const slugs = await discover(ats, useCrawls);
    const out = path.join(OUT_DIR, `cc-slugs-${ats}.json`);
    fs.writeFileSync(out, JSON.stringify({
      ats, source: 'commoncrawl-url-index', pattern: TARGETS[ats].pattern,
      crawls: useCrawls, generated_at: new Date().toISOString(), count: slugs.length, slugs,
    }, null, 2));
    console.error(`  → ${slugs.length} slugs → ${out}\n`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
