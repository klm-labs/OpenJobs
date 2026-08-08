// discover-lever-github.mjs — enumerate Lever tenant slugs via GitHub code search.
//
// WHY: Lever is path-based on one shared host (jobs.lever.co/{slug}), so neither Certificate
// Transparency (no per-tenant certs) nor the Common Crawl URL index (jobs.lever.co/robots.txt
// blocks crawlers — CC has literally 1 indexed URL for that host) can enumerate its tenants.
//
// What DOES work: Lever board URLs are pasted all over public GitHub — job-board aggregator
// repos, "companies that sponsor visas" lists, awesome-jobs READMEs, scraper configs, personal
// job-hunt trackers. GitHub's code search API returns the matching text fragment, so one search
// result typically yields several distinct slugs.
//
// The API caps any single query at 1000 results (10 pages x 100), so we run the same phrase
// across many `language:` / qualifier slices to get well past that ceiling, then union the slugs.
//
// Requires: `gh auth login` (uses the gh CLI's token). Code search is rate-limited to ~10
// requests/minute, so a full run takes ~15-25 minutes.
//
// Output: output/gh-slugs-lever.json → { ats, generated_at, slugs: [...] }
//
// Usage:
//   node discover-lever-github.mjs
//   node discover-lever-github.mjs --pages 10

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const PHRASES = ['"jobs.lever.co"', '"jobs.eu.lever.co"', '"api.lever.co/v0/postings"'];

// Slices used to break past the 1000-results-per-query ceiling. Each is appended to a phrase.
const SLICES = [
  '', 'language:markdown', 'language:json', 'language:html', 'language:javascript',
  'language:typescript', 'language:python', 'language:yaml', 'language:text',
  'language:csv', 'language:ruby', 'language:go', 'language:java', 'language:php',
  'language:shell', 'language:xml', 'language:vue', 'language:scss', 'language:css',
  'language:jsx', 'language:sql', 'language:toml', 'language:rust', 'language:svelte',
];

// Slugs that are path segments of the Lever product itself, not tenants.
const RESERVED = new Set([
  'robots.txt', 'sitemap.xml', 'favicon.ico', 'apply', 'jobs', 'postings', 'v0',
  'static', 'assets', 'img', 'images', 'css', 'js', 'api', 'www', 'null', 'undefined',
  'yourcompany', 'company', 'companyname', 'example', 'your-company', 'acme', 'test',
]);

const args = process.argv.slice(2);
function arg(n, d) { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; }

const MAX_PAGES = Number(arg('pages', 10));
const OUT = path.join(process.cwd(), 'output', 'gh-slugs-lever.json');

const SLUG_RE = /jobs(?:\.eu)?\.lever\.co\/([A-Za-z0-9][A-Za-z0-9_.-]{1,60})|api\.lever\.co\/v0\/postings\/([A-Za-z0-9][A-Za-z0-9_.-]{1,60})/g;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ghSearch(q, page) {
  // Retries cover both secondary-rate-limit 403s and transient 5xx.
  for (let i = 0; i < 4; i++) {
    try {
      const { stdout } = await execFileP('gh', [
        'api', '-X', 'GET', 'search/code',
        '-H', 'Accept: application/vnd.github.text-match+json',
        '-f', `q=${q}`, '-f', 'per_page=100', '-f', `page=${page}`,
      ], { maxBuffer: 64 * 1024 * 1024 });
      return JSON.parse(stdout);
    } catch (e) {
      const msg = String(e.stderr || e.message);
      // 422 = past the 1000-result window for this query; not retryable.
      if (msg.includes('422')) return null;
      await sleep(20000 * (i + 1));
    }
  }
  return null;
}

function harvest(json, into) {
  if (!json?.items) return 0;
  let n = 0;
  for (const item of json.items) {
    const blobs = [item.path || '', ...(item.text_matches || []).map(t => t.fragment || '')];
    for (const blob of blobs) {
      for (const m of blob.matchAll(SLUG_RE)) {
        let slug = (m[1] || m[2] || '').replace(/[.,)\]"'`]+$/, '').toLowerCase();
        if (!slug || RESERVED.has(slug) || slug.length < 2) continue;
        if (!into.has(slug)) { into.add(slug); n++; }
      }
    }
  }
  return n;
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const slugs = new Set();

  for (const phrase of PHRASES) {
    for (const slice of SLICES) {
      const q = slice ? `${phrase} ${slice}` : phrase;
      let added = 0, got = 0;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const j = await ghSearch(q, page);
        if (!j || !j.items?.length) break;
        got += j.items.length;
        added += harvest(j, slugs);
        if (j.items.length < 100) break;
        // Code search allows ~10 req/min; pace to stay under the secondary limit.
        await sleep(6500);
      }
      console.error(`${q.padEnd(48)} ${String(got).padStart(4)} hits → +${added} (total ${slugs.size})`);
      await sleep(2000);
    }
  }

  const out = [...slugs].sort();
  fs.writeFileSync(OUT, JSON.stringify({
    ats: 'lever', source: 'github-code-search', phrases: PHRASES,
    generated_at: new Date().toISOString(), count: out.length, slugs: out,
  }, null, 2));
  console.error(`\n→ ${out.length} slugs → ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
