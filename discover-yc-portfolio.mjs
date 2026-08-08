// discover-yc-portfolio.mjs — pull Y Combinator's public company directory and
// emit candidate companies_v2.json-shaped records for companies not already in
// our dataset (matched by website domain).
//
// Why this exists (see output/yc-research-notes.md for the full writeup):
//   workatastartup.com (YC's jobs board) is a login-gated React/Vite app. Its
//   /jobs page embeds a client-side Algolia search key (window.AlgoliaOpts),
//   but that key is an Algolia *secured API key* whose server-enforced
//   tagFilters=[["none"]] restriction returns 0 hits for every index no matter
//   what params the client sends — i.e. YC deliberately scopes the anonymous
//   key to return nothing. There is no public jobs feed, RSS, sitemap, or
//   __NEXT_DATA__ blob with real postings. So instead of a jobs adapter, this
//   script does company discovery: YC's plain directory API
//   (api.ycombinator.com/v0.1/companies) IS public and unauthenticated, and
//   carries name/website/batch/status/tags/industries/locations (no job or
//   ATS data). New companies discovered here get routed through our EXISTING
//   Greenhouse/Lever/Ashby/etc adapters normally once merged.
//
// This script does NOT write to data/companies_v2.json. It writes a dated
// candidate file to output/ for manual review/merge, mirroring the
// a16z-portfolio discovery pattern.
//
// Usage:
//   node discover-yc-portfolio.mjs                # full sweep, all pages
//   node discover-yc-portfolio.mjs --limit 5       # first 5 pages (pilot)
//   node discover-yc-portfolio.mjs --per-page 200  # override page size

import fs from 'node:fs';
import path from 'node:path';

const API_BASE = 'https://api.ycombinator.com/v0.1/companies';
const TIMEOUT_MS = 15000;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);

function parseArgs(argv) {
  const args = { limit: Infinity, perPage: 1000 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else if (argv[i] === '--per-page') args.perPage = Number(argv[++i]);
  }
  return args;
}

async function fetchJsonRetry(url, opts = {}, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        if (RETRY_STATUSES.has(res.status) && attempt < retries) {
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      throw err;
    }
  }
}

function normalizeDomain(website) {
  if (!website || typeof website !== 'string') return '';
  try {
    let s = website.trim();
    if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
    const host = new URL(s).hostname.toLowerCase();
    return host.replace(/^www\./, '');
  } catch {
    return website.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  }
}

function loadExistingDomains() {
  const raw = fs.readFileSync(path.join(process.cwd(), 'data', 'companies_v2.json'), 'utf8');
  const companies = JSON.parse(raw);
  const domains = new Set();
  for (const c of companies) {
    const d = normalizeDomain(c.website);
    if (d) domains.add(d);
  }
  return { domains, count: companies.length };
}

async function fetchAllCompanies({ limit, perPage }) {
  const all = [];
  let page = 1;
  let totalPages = 1;
  do {
    const url = `${API_BASE}?page=${page}&per_page=${perPage}`;
    let json;
    try {
      json = await fetchJsonRetry(url, { headers: { 'User-Agent': 'Mozilla/5.0 (open-jobs discover-yc-portfolio)' } }, 2);
    } catch (err) {
      console.warn(`[warn] page ${page} failed: ${err.message}`);
      break;
    }
    const batch = Array.isArray(json?.companies) ? json.companies : [];
    all.push(...batch);
    totalPages = json?.totalPages || 1;
    console.log(`[fetch] page ${page}/${totalPages} — ${batch.length} companies (running total: ${all.length})`);
    page++;
  } while (page <= totalPages && page <= limit);
  return all;
}

function toCandidateRecord(ycCompany) {
  return {
    name: ycCompany.name || '',
    website: ycCompany.website || '',
    industry_category: 'tech',
    type: 'tech',
    game_genre: [],
    tech_stack: [],
    ats_links: [],
    list_urls: [],
    countries: Array.isArray(ycCompany.regions) ? ycCompany.regions : [],
    _source: 'yc-portfolio',
    _yc_id: String(ycCompany.id ?? ''),
    _yc_slug: ycCompany.slug || '',
    _yc_batch: ycCompany.batch || '',
    _yc_status: ycCompany.status || '',
    _yc_tags: Array.isArray(ycCompany.tags) ? ycCompany.tags : [],
    _yc_industries: Array.isArray(ycCompany.industries) ? ycCompany.industries : [],
    _yc_team_size: ycCompany.teamSize ?? '',
  };
}

function toCsvRow(fields) {
  return fields
    .map(f => {
      const s = String(f ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(',');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[start] discover-yc-portfolio — limit=${args.limit === Infinity ? 'none' : args.limit} pages, per_page=${args.perPage}`);

  const { domains: existingDomains, count: existingCount } = loadExistingDomains();
  console.log(`[dataset] ${existingCount} existing companies, ${existingDomains.size} unique domains`);

  const ycCompanies = await fetchAllCompanies(args);
  console.log(`[fetch] total YC companies pulled: ${ycCompanies.length}`);

  const seenDomains = new Set();
  const rows = [];
  let newCandidates = 0;
  let alreadyInDataset = 0;
  let dupWithinYc = 0;
  let noDomain = 0;

  for (const yc of ycCompanies) {
    const domain = normalizeDomain(yc.website);
    if (!domain) {
      noDomain++;
      continue;
    }
    if (seenDomains.has(domain)) {
      dupWithinYc++;
      continue;
    }
    seenDomains.add(domain);

    const status = existingDomains.has(domain) ? 'already-in-dataset' : 'new-candidate';
    if (status === 'already-in-dataset') alreadyInDataset++;
    else newCandidates++;

    rows.push({ yc, domain, status });
  }

  const today = new Date().toISOString().slice(0, 10);
  const outDir = path.join(process.cwd(), 'output');
  fs.mkdirSync(outDir, { recursive: true });

  const jsonOut = rows
    .filter(r => r.status === 'new-candidate')
    .map(r => toCandidateRecord(r.yc));
  const jsonPath = path.join(outDir, `yc-portfolio-${today}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(jsonOut, null, 2));

  const csvHeader = 'name,website,domain,status,yc_id,slug,batch,yc_status,team_size';
  const csvLines = [csvHeader, ...rows.map(r => toCsvRow([
    r.yc.name, r.yc.website, r.domain, r.status, r.yc.id, r.yc.slug, r.yc.batch, r.yc.status, r.yc.teamSize,
  ]))];
  const csvPath = path.join(outDir, `yc-portfolio-${today}.csv`);
  fs.writeFileSync(csvPath, csvLines.join('\n') + '\n');

  console.log('');
  console.log('=== Summary ===');
  console.log(`YC companies fetched:        ${ycCompanies.length}`);
  console.log(`  no usable website/domain:  ${noDomain}`);
  console.log(`  duplicate domain in YC:    ${dupWithinYc}`);
  console.log(`  already in companies_v2:   ${alreadyInDataset}`);
  console.log(`  NEW candidates:            ${newCandidates}`);
  console.log('');
  console.log(`Wrote ${jsonPath} (${jsonOut.length} new-candidate records)`);
  console.log(`Wrote ${csvPath} (${rows.length} total rows, all statuses)`);
}

main().catch(err => {
  console.error('[fatal]', err);
  process.exit(1);
});
