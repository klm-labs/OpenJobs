// discover-a16z-portfolio.mjs — discover new companies from a16z's full portfolio.
//
// a16z's portfolio page (https://a16z.com/portfolio/) is NOT a job board — it's a
// company directory. Unlike adapters/*.mjs (which pull jobs from a known ATS), this
// script's job is dataset EXPANSION: find portfolio companies that aren't yet in
// data/companies_v2.json and emit them as candidate records, in the same shape as
// existing companies_v2.json entries, ready for a human/merge step to splice in.
//
// Once merged into companies_v2.json, these new companies flow through the existing
// pipeline automatically: harvest.mjs's routeCompany() will pick up any that already
// carry a recognizable ats_links URL (rare — a16z only gives us the company website),
// and probe-ats.mjs's slug-probe sweep will discover ATS boards for the rest — exactly
// the same two-step discovery→merge pattern probe-ats.mjs / merge-probe-hits.mjs use.
//
// Where the data comes from:
//   a16z.com/portfolio/ server-renders the full portfolio list into a single JS
//   array assigned to `window.a16z_portfolio_companies` inside a <script> tag on
//   the page (Alpine.js-driven filter UI reads from it client-side). That's more
//   reliable than scraping DOM anchors/JSON-LD (the page's JSON-LD blocks only
//   describe the WebPage/Organization, not individual portfolio companies) — so
//   this script parses that embedded array directly instead of porting upstream
//   career-ops's JSON-LD/data-attribute/anchor-regex fallback chain.
//
// This script NEVER writes to data/companies_v2.json directly — see the header
// comment in merge-probe-hits.mjs for why (shared file, explicit opt-in apply step).
//
// Usage:
//   node discover-a16z-portfolio.mjs                 # fetch, cross-reference, write candidates
//   node discover-a16z-portfolio.mjs --dry-run        # fetch + report only, no output files
//   node discover-a16z-portfolio.mjs --limit 50        # cap portfolio companies processed (testing)
//   node discover-a16z-portfolio.mjs --json-only       # skip fetch, work purely as documented below

import fs from 'node:fs';
import path from 'node:path';

const A16Z_PORTFOLIO_URL = 'https://a16z.com/portfolio/';
const TIMEOUT_MS = 20000;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// ── CLI args ─────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { limit: Infinity, dryRun: false, companies: 'data/companies_v2.json', htmlFile: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--companies') out.companies = argv[++i];
    else if (a === '--html-file') out.htmlFile = argv[++i]; // offline testing: parse a saved HTML snapshot
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node discover-a16z-portfolio.mjs [--limit N] [--dry-run] [--companies PATH] [--html-file PATH]');
      process.exit(0);
    }
  }
  return out;
}

// ── Fetch ────────────────────────────────────────────────────────

async function fetchPortfolioHtml() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(A16Z_PORTFOLIO_URL, {
      signal: ctl.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ── Parse: extract window.a16z_portfolio_companies = [...] from the page ──
//
// The page embeds the full portfolio as a single JS array literal assigned to a
// global right before the filter UI's <script> block, e.g.:
//   <script>window.a16z_portfolio_companies = [{"id":"373009",...}, ...];</script>
// We regex out the array literal (non-greedy up to the closing `];`) and JSON.parse
// it directly — it's valid JSON (double-quoted keys/strings), just embedded in JS.

function parseA16zPayload(html) {
  if (typeof html !== 'string' || !html.trim()) return [];
  const m = html.match(/window\.a16z_portfolio_companies\s*=\s*(\[.*?\]);/s);
  if (!m) return [];
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch (e) {
    console.error('[fatal] failed to JSON.parse the embedded portfolio array:', e.message);
    return [];
  }
  if (!Array.isArray(data)) return [];

  return data
    .map(item => {
      const name = typeof item?.title === 'string' ? item.title.trim() : '';
      const website = typeof item?.web === 'string' ? item.web.trim() : '';
      const stages = Array.isArray(item?.stages) ? item.stages : [];
      return {
        name,
        website,
        a16z_id: item?.id || '',
        stages,
        acquirer: item?.acquirer || '',
        exit_date: item?.exit_date || '',
      };
    })
    .filter(c => c.name); // website may be missing for a handful; keep the name-only ones out of candidates later
}

// ── Domain normalization for cross-referencing ─────────────────────

function normalizeDomain(url) {
  if (!url) return '';
  let s = String(url).trim().toLowerCase();
  if (!s) return '';
  if (!/^https?:\/\//.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    let host = u.hostname.replace(/^www\./, '');
    return host;
  } catch {
    return '';
  }
}

// ── CSV helper (matches probe-ats.mjs's convention) ─────────────────

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  console.log(`Fetching a16z portfolio: ${A16Z_PORTFOLIO_URL}`);
  let html;
  if (args.htmlFile) {
    console.log(`  (offline mode) reading HTML from ${args.htmlFile}`);
    html = fs.readFileSync(args.htmlFile, 'utf8');
  } else {
    html = await fetchPortfolioHtml();
  }
  console.log(`  fetched ${html.length.toLocaleString()} bytes`);

  let portfolio = parseA16zPayload(html);
  console.log(`Parsed portfolio companies: ${portfolio.length}`);
  if (portfolio.length === 0) {
    console.error('[fatal] no companies parsed — the page structure may have changed. Bailing out without writing output.');
    process.exit(1);
  }

  if (Number.isFinite(args.limit)) {
    portfolio = portfolio.slice(0, args.limit);
    console.log(`After --limit=${args.limit}: ${portfolio.length}`);
  }

  const noWebsite = portfolio.filter(c => !c.website).length;
  console.log(`  companies with no website field: ${noWebsite}`);

  // ── Load existing dataset, build normalized-domain index ─────────
  console.log(`\nReading companies: ${args.companies}`);
  const raw = JSON.parse(fs.readFileSync(args.companies, 'utf8'));
  const companies = Array.isArray(raw) ? raw : (raw.companies || raw.data || []);
  console.log(`  ${companies.length} companies loaded`);

  const existingDomains = new Set();
  const existingNames = new Set();
  for (const c of companies) {
    const d1 = normalizeDomain(c.website);
    if (d1) existingDomains.add(d1);
    for (const link of (Array.isArray(c.ats_links) ? c.ats_links : [])) {
      const d2 = normalizeDomain(link);
      if (d2) existingDomains.add(d2);
    }
    if (c.name) existingNames.add(String(c.name).toLowerCase().trim());
  }

  // ── Cross-reference ────────────────────────────────────────────
  const seenA16zDomains = new Set(); // dedupe within the a16z list itself
  const results = []; // for the CSV summary — every a16z company + its status
  const candidates = []; // net-new companies, in companies_v2.json record shape

  for (const c of portfolio) {
    const domain = normalizeDomain(c.website);
    let status;

    if (!c.website) {
      status = 'no-website';
    } else if (domain && seenA16zDomains.has(domain)) {
      status = 'dup-in-a16z-list';
    } else if (domain && existingDomains.has(domain)) {
      status = 'already-in-dataset';
    } else if (existingNames.has(c.name.toLowerCase().trim())) {
      status = 'already-in-dataset-by-name';
    } else {
      status = 'new-candidate';
    }

    if (domain) seenA16zDomains.add(domain);

    results.push({ ...c, domain, status });

    if (status === 'new-candidate') {
      candidates.push({
        name: c.name,
        website: c.website,
        industry_category: 'tech', // a16z spans far more than gaming; best-guess default
        type: 'tech',
        game_genre: [],
        tech_stack: [],
        ats_links: [],
        list_urls: [],
        countries: [],
        // Extra provenance fields — not part of the companies_v2.json schema.
        // Strip these (or fold into a comment) when actually splicing into
        // companies_v2.json; kept here so a human reviewer can sanity-check
        // exit status before merging (e.g. skip companies long acquired into
        // a parent that already has its own ATS entry).
        _source: 'a16z-portfolio',
        _a16z_id: c.a16z_id,
        _a16z_stages: c.stages,
        _a16z_acquirer: c.acquirer,
        _a16z_exit_date: c.exit_date,
      });
    }
  }

  const statusCounts = {};
  for (const r of results) statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;

  console.log('\n=== Cross-reference summary ===');
  console.log(`  a16z portfolio companies parsed: ${portfolio.length}`);
  for (const [status, n] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${status.padEnd(28)} ${n}`);
  }
  console.log(`  net-new candidates:           ${candidates.length}`);

  if (args.dryRun) {
    console.log('\n[dry-run] No output files written.');
    return;
  }

  fs.mkdirSync('output', { recursive: true });
  const date = new Date().toISOString().slice(0, 10);

  const csvPath = path.join('output', `a16z-portfolio-${date}.csv`);
  const csvHeader = 'name,website,domain,status,a16z_id,stages,acquirer,exit_date\n';
  const csvRows = results.map(r => [
    r.name, r.website, r.domain, r.status, r.a16z_id,
    (r.stages || []).join('|'), r.acquirer, r.exit_date,
  ].map(csvEscape).join(','));
  fs.writeFileSync(csvPath, csvHeader + csvRows.join('\n') + '\n');
  console.log(`\nFull portfolio CSV (all statuses): ${csvPath}`);

  const jsonPath = path.join('output', `a16z-portfolio-${date}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(candidates, null, 2));
  console.log(`Net-new candidate records (companies_v2.json shape): ${jsonPath}`);

  console.log(`\nNext step (not run by this script): review ${jsonPath}, strip the`);
  console.log(`_a16z_* provenance fields, and append the records into data/companies_v2.json`);
  console.log(`(mirroring how merge-probe-hits.mjs is a separate, explicit apply step).`);
  console.log(`After merging, run probe-ats.mjs to discover each new company's ATS board.`);
}

main().catch(e => { console.error(e); process.exit(1); });
