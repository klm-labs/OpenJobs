# OpenJobs Audit and Remediation Tasks

## Audit snapshot

- Audit date: 2026-08-09 UTC
- Repository: `https://github.com/klm-labs/OpenJobs`
- Audited commit: `04bff216400636304fbe68750416f6027bdefd3b`
- Branch: `main`, matching `origin/main` at audit time
- The KLM repository was a fork of `outscal/OpenJobs` and was 15 commits ahead at audit time.
- Scope reviewed: harvester, ATS adapters, discovery scripts, dataset, Career-Ops inheritance, updater, tests, Go dashboard, CI/release setup, documentation, privacy, security, and GitHub configuration.

## Overall assessment

OpenJobs has a useful core: a plain JSON company dataset, an understandable local CLI, and a small adapter contract that makes ATS support easy to extend. The Go dashboard is healthy, and the repository contains sensible foundations such as bounded concurrency, timeouts, dry-run paths, backup-before-merge behavior, CodeQL, dependency review, and explicit anti-spam rules.

It is still a prototype, not a trustworthy production data pipeline. The highest risks are silent output loss, confirmed adapter correctness defects, an unsafe cross-repository updater, personal files that can accidentally be committed, broken/mutating tests, stale dataset claims, and CI that has never run or been enforced on this fork.

**Do not run `node update-system.mjs apply` until the updater is redesigned. Do not rely on harvested CSVs as complete until the P0/P1 correctness tasks below are addressed.**

## Confirmed strengths

- All 17 adapters import successfully and expose the documented `ATS`, `detect`, and `fetchJobs` interface.
- Adapter registration and routing are easy to understand: [`adapters/index.mjs`](adapters/index.mjs).
- Common normalization expectations are documented: [`adapters/README.md`](adapters/README.md).
- The harvester has bounded global concurrency and a shared timeout concept: [`harvest.mjs`](harvest.mjs).
- Newer adapters contain pagination guards and targeted retry/backoff behavior.
- Workable's board-wide search is opt-in and resumable.
- Probe merging defaults to preview mode and creates a backup before writing.
- The README correctly distinguishes historical company-country data from live posting-location filtering.
- Human review, quality-over-quantity, and no-auto-submit rules are explicit in [`CLAUDE.md`](CLAUDE.md).
- Go dashboard verification passed completely.
- No committed credentials or obvious API secrets were found.
- Original Career-Ops and Outscal attribution is preserved in [`LICENSE`](LICENSE).

## Verification results

### Node and repository suite

- `node test-all.mjs --quick`: **failed** with `74 passed, 1 failed, 9 warnings`.
- Failure: [`test-all.mjs`](test-all.mjs) expects `.claude/skills/career-ops/SKILL.md`; this fork ships `.claude/skills/outscal-jobs/SKILL.md`.
- All tracked root and adapter `.mjs` files passed `node --check` when checked independently.
- A bounded live Greenhouse smoke run fetched two jobs and exited successfully.
- Dependency installs under isolated Node 18 and Node 20 environments reported zero known npm vulnerabilities.
- Without a lockfile, the two environments resolved different Playwright versions (1.61.1 vs. 1.62.1).
- `npm ci` fails because no lockfile is committed.

### Go dashboard

The following passed with the Go version required by `dashboard/go.mod` (1.24.2):

- `go test -mod=readonly ./...`
- `go test -race ./...`
- `go vet ./...`
- `go build ./...`
- `go mod verify`

### Workflows and GitHub state

- Static `actionlint` validation passed for all workflow files.
- GitHub reported eight active workflow definitions but zero workflow runs and zero checks/statuses on the audited commit.
- `main` was unprotected and there were no repository rulesets.
- Issues and Discussions were disabled.
- Private vulnerability reporting was disabled.
- There were no tags or releases.
- This contradicts the enforced-CI and branch-protection claims in [`CLAUDE.md`](CLAUDE.md).

## Measured repository/data facts

These values were computed from the audited checkout and should eventually be generated automatically rather than copied into documentation:

| Metric | Audited value |
|---|---:|
| Dataset records | 21,326 |
| Records with non-empty `ats_links` | 10,587 |
| Records claimed by the adapter registry | 5,941 |
| Registered adapters | 17 |
| Records with countries | 3,036 |
| Unique raw country labels | 202 |
| Jobvite routes that intentionally fetch nothing | 84 |
| Records matching more than one adapter | 165 |
| Duplicate routed endpoint groups | 148 |
| Redundant fetches implied by those groups | 174 |
| Invalid `ats_links` values | 1,792 |
| Invalid placeholder variants such as `aaaaaaaa...` | 1,785 |
| Duplicate normalized-name groups | 261 |
| Blank websites | 1,483 |
| Records with plural `list_urls` | 7,208 |
| Records with singular `listUrl` | 0 |

README figures such as 12,144 companies, about 2,100 routable companies, 13 adapters, 2,529 records with countries, and 155 country labels are stale.

## P0 — safety and data-loss blockers

### 1. Disable or redesign the upstream updater

- [ ] Prevent `update-system.mjs apply` from replacing fork-owned files from mutable `santifer/career-ops/main`.
- [ ] Do not overwrite `CLAUDE.md`, `AGENTS.md`, `README.md`, `package.json`, `LICENSE`, `.github/`, OpenJobs skills, or fork documentation.
- [ ] Pin updates to reviewed tags/commits and verify the fetched commit/checksum.
- [ ] Maintain a fork-owned, minimal allowlist of genuinely shared files.
- [ ] Refuse to update a dirty working tree unless the user explicitly handles the changes.
- [ ] Run validation before committing an update; abort if dependency installation or tests fail.
- [ ] Avoid npm lifecycle scripts during the update unless explicitly required and reviewed.
- [ ] Make rollback restore dependencies as well as files.
- [ ] Add updater integration tests in temporary repositories.

Evidence: [`update-system.mjs:26-72`](update-system.mjs), which checks out prompts, metadata, workflows, docs, package metadata, and the license from another repository before running `npm install`.

The update checker reported Career-Ops `1.3.0 -> 1.25.0`, but parsed the remote value as `1.25.0 # x-release-please-version`. Version parsing must strip/validate comments before any updater work resumes.

### 2. Protect all personal and secret-bearing files

- [ ] Add `.env`, `.env.*`, `article-digest.md`, and `data/follow-ups.md` to `.gitignore`.
- [ ] Ignore generated files under `interview-prep/`.
- [ ] Move the tracked `interview-prep/story-bank.md` seed to a template/example, then ignore the user copy.
- [ ] Audit every User Layer path in [`DATA_CONTRACT.md`](DATA_CONTRACT.md) against `.gitignore` in CI.
- [ ] Add a secret-scanning workflow or repository secret-scanning configuration.
- [ ] Ensure onboarding never creates a trackable file containing PII or credentials.

Current mismatch: [`DATA_CONTRACT.md:5-23`](DATA_CONTRACT.md) classifies these as personal, while [`.gitignore`](.gitignore) does not protect all of them. [`.envrc`](.envrc) explicitly loads `.env`, which is currently trackable.

### 3. Prevent CSV/TSV injection and corruption

- [ ] Neutralize values beginning with `=`, `+`, `-`, `@`, tab, or carriage return before writing spreadsheet-oriented CSV.
- [ ] Escape tabs/newlines in history TSV fields.
- [ ] Validate `detail_url` and `apply_url` schemes before output.
- [ ] Add malicious-title/company/location fixtures.

Evidence: [`harvest.mjs:259-269`](harvest.mjs) only performs conventional CSV quoting, and history is appended without TSV-safe escaping around line 475.

### 4. Make tests non-mutating

- [ ] Stop running normalize, dedup, and merge against the user's actual files from `test-all.mjs`.
- [ ] Run mutation tests only against fixtures in temporary directories.
- [ ] Use `--dry-run` for any smoke invocation that touches a real checkout.
- [ ] Abort subsequent test sections after an integrity precondition fails.
- [ ] Confirm with a test that `git status` and user-layer file hashes are unchanged.

Evidence: [`test-all.mjs:65-82`](test-all.mjs) invokes maintenance scripts in write mode. In an isolated reproduction, the suite normalized and deduplicated `data/applications.md`, merged a pending row, made a backup, and moved a TSV even though verification had already failed.

## P1 — harvester correctness

### 5. Make output and history transactional

- [ ] Do not overwrite earlier same-day results while permanently adding them to history.
- [ ] Choose and document one output policy: timestamped immutable runs, atomic merge into a daily file, or a canonical database plus exports.
- [ ] Update history only after the final output is safely written.
- [ ] Use atomic temporary-file-plus-rename writes.
- [ ] Do not advance the Workable cursor during `--dry-run`.
- [ ] Persist run metadata: start/end, config hash, counts, failures, cursor state, and output path.
- [ ] Add interruption/resume and repeated-same-day integration tests.

Evidence: [`harvest.mjs:463-476`](harvest.mjs) overwrites `jobs-YYYY-MM-DD.csv` and then appends URLs to permanent history. [`adapters/workable-search.mjs`](adapters/workable-search.mjs) persists its cursor even during a harvester dry run.

### 6. Replace first-match routing with endpoint-aware routing

- [ ] Evaluate all compatible adapters/endpoints for each company rather than returning the first registry match.
- [ ] When `--ats X` is supplied, call that adapter's detector directly instead of routing first and filtering later.
- [ ] Preserve multiple legitimate boards where a company has migrated or runs regional boards.
- [ ] Deduplicate normalized endpoints before fetching.
- [ ] Deduplicate jobs within the run by canonical URL and a stable fallback key.
- [ ] Add fallback behavior when the preferred endpoint fails or is stale.

Current impact: 165 records match multiple adapters. `--ats ashby` misses 53 Ashby-detectable records because an earlier adapter wins. There are 148 duplicate endpoint groups causing 174 redundant fetches.

Evidence: [`adapters/index.mjs:48-55`](adapters/index.mjs) stops at the first match; [`harvest.mjs:349-352`](harvest.mjs) applies the allowlist afterward.

### 7. Repair confirmed adapter defects

- [ ] **Lever:** select `api.eu.lever.co` for `jobs.eu.lever.co`. Twelve current records are affected; a live Kwalee probe returned 404 from the US API and 200 from the EU API.
- [ ] **Greenhouse:** correctly extract the capture group from explicit `/boards/{slug}` API URLs.
- [ ] **Greenhouse:** parse `?for={tenant}` on `/embed/job_board` URLs instead of treating `embed` as the board slug. Seventeen records are currently misrouted.
- [ ] **SmartRecruiters:** emit the actual job-detail URL on `jobs.smartrecruiters.com`, not a careers-board URL that redirects to the board root.
- [ ] **Workday:** preserve `?q=`/search filters and avoid fetching/misattributing the entire shared parent tenant.
- [ ] **Workable/Workday:** stop using `fetchJson.length >= 2` as a capability check. The production helper has JavaScript function length 1 because its second parameter has a default, so both adapters bypass the shared timeout.
- [ ] Add deterministic fixtures and mocked pagination/error tests for every repair.

Relevant files: [`adapters/lever.mjs`](adapters/lever.mjs), [`adapters/greenhouse.mjs`](adapters/greenhouse.mjs), [`adapters/smartrecruiters.mjs`](adapters/smartrecruiters.mjs), [`adapters/workday.mjs`](adapters/workday.mjs), and [`adapters/workable.mjs`](adapters/workable.mjs).

### 8. Report failures and partial success explicitly

- [ ] Track per-adapter attempted/succeeded/empty/failed/skipped counts.
- [ ] Include representative error reasons and HTTP statuses in the run report.
- [ ] Distinguish a genuine empty board from a parser/network failure.
- [ ] Return non-zero when failures exceed a documented threshold.
- [ ] Make intentionally unsupported Jobvite records manual/skipped, not apparently successful routable records.
- [ ] Keep verbose logs optional, but always print a concise failure summary.

Evidence: errors are captured around [`harvest.mjs:394-402`](harvest.mjs) but ignored during flattening and final reporting. Jobvite can return zero jobs with exit 0 and no explanation.

### 9. Repair configuration and filter behavior

- [ ] Provide a harvester-specific example config, or make `portals.yml` genuinely optional with safe defaults.
- [ ] Add all documented keys to the example: `locations`, `manual_only`, `industry_allowlist`, and `ats_allowlist`.
- [ ] Validate YAML against a schema and report actionable errors.
- [ ] Consume dataset `list_urls` consistently; optionally support legacy singular `listUrl` during migration.
- [ ] Check the structured `remote` flag before rejecting an empty location.
- [ ] Replace raw substring title matching with token/boundary/regex-aware matching. The default `AI` currently matches words such as `Retail` and `Maintenance`.
- [ ] Use structured location information when adapters provide it; avoid substring false positives such as `UK` matching `Fukuoka`.
- [ ] Route ATS-capable records before applying `manual_only`; otherwise a secondary LinkedIn link can divert a valid public ATS board.
- [ ] In manual output, emit the URL that actually matched the manual-host rule rather than `ats_links[0]`.

Evidence: [`harvest.mjs:162-167`](harvest.mjs) requires the file; [`templates/portals.example.yml`](templates/portals.example.yml) omits the harvester-specific keys; [`harvest.mjs:342`](harvest.mjs) reads singular `listUrl` while the dataset uses plural `list_urls`.

### 10. Bound expensive aggregators and probes

- [ ] Make all board-wide aggregators explicit opt-ins, not only `workable-search`.
- [ ] Add per-provider concurrency/rate limits, `Retry-After` handling, jitter, and identifying User-Agent/contact information.
- [ ] Stream/filter results rather than retaining large `raw` payloads for all jobs.
- [ ] Add configurable page/job ceilings and estimated-call previews.
- [ ] Replace `probe-ats.mjs`'s mass promise creation with a real bounded producer/worker queue.
- [ ] Document a vendor policy/ToS matrix and default to conservative probing.

The current dataset includes 41 Getro and 26 Consider collections plus the large a16z feed. `probe-ats.mjs` can create roughly 167,000 promises at once despite defining a pool helper.

## P1 — dataset governance and quality

### 11. Define a versioned dataset contract

- [ ] Publish a machine-readable JSON Schema.
- [ ] Add stable record IDs that survive name/domain changes.
- [ ] Add snapshot/generated timestamps and dataset versioning.
- [ ] Record source URL(s), source system, discovery time, verification time, and confidence per record/field.
- [ ] Distinguish current, historical, unverified, stale, and manual-only ATS links.
- [ ] Publish an explicit dataset license, not only a software license.
- [ ] Document correction, removal, and dispute processes.
- [ ] Obtain legal review for data provenance, internal-production derivation, phone-like values, and the blanket GDPR statements.

### 12. Clean and validate the current snapshot

- [ ] Remove the null/empty record.
- [ ] Remove or quarantine the 1,792 invalid ATS links, especially placeholder `aaaaaaaa...` values.
- [ ] Normalize website URLs without turning email addresses, phone numbers, or `-` into websites.
- [ ] Normalize country labels to a documented canonical vocabulary while retaining raw source values if needed.
- [ ] Resolve duplicate companies using stable IDs and multiple signals, not normalized name alone.
- [ ] Audit unrelated companies sharing placeholder/generic website values.
- [ ] Verify that ATS links belong to the intended company.
- [ ] Validate industry-category vocabulary/casing and all array element types.
- [ ] Make data validation a required CI check.

### 13. Make discovery and merge auditable

- [ ] Preserve candidate source/provenance through verification and merge.
- [ ] Replace name-only merge keys with stable IDs/domain/ATS-tenant evidence plus manual conflict review.
- [ ] Use a real CSV parser; the current custom parser mishandles escaped quotes.
- [ ] Produce a review manifest containing additions, updates, conflicts, rejects, and reasons.
- [ ] Never silently let a later normalized-name collision win.
- [ ] Add idempotency and rollback tests.

Relevant code: [`merge-probe-hits.mjs`](merge-probe-hits.mjs) and the `discover-*.mjs`/`verify-ats-candidates.mjs` scripts.

## P1 — tests, dependencies, and CI

### 14. Test the actual OpenJobs product

- [ ] Fix the stale skill-file assertion so the current suite can pass.
- [ ] Add an `npm test` script.
- [ ] Syntax/import-check root scripts and every adapter.
- [ ] Test every adapter with saved, sanitized fixtures for normal, empty, pagination, rate-limit, and malformed responses.
- [ ] Test routing, multi-ATS fallback, `--ats`, filters, configuration validation, URL normalization, CSV/TSV escaping, history, and same-day output behavior.
- [ ] Add a fully mocked end-to-end harvest test with no live network dependency.
- [ ] Keep a small optional live smoke suite separate from required deterministic CI.
- [ ] Add dataset schema/statistics/duplicate/URL validation.
- [ ] Add coverage reporting for the core harvester and adapters.

Current [`test-all.mjs`](test-all.mjs) mostly checks root syntax, file presence, prompts, and two liveness cases. It does not cover the adapters or harvester behavior.

### 15. Make Node installs reproducible

- [ ] Stop ignoring `package-lock.json` and commit a reviewed lockfile.
- [ ] Use `npm ci` in CI.
- [ ] Add `engines.node`, `packageManager`, and a local Node version file.
- [ ] Decide the supported Node matrix and test it explicitly.
- [ ] Separate harvester dependencies from optional legacy PDF/Playwright tooling if possible.
- [ ] Reconcile Dependabot and Renovate to avoid duplicated dependency PRs.

### 16. Expand CI and Nix coverage

- [ ] Split CI into Node unit/integration tests, dataset validation, and Go checks.
- [ ] Run Go format/vet/test/race/build, not merely install Go and skip the dashboard.
- [ ] Run required checks on PRs and pushes to `main`.
- [ ] Add Go 1.24.2 or the chosen compatible version to `flake.nix`.
- [ ] Remove the silent networked `npm install` from the Nix shell hook.
- [ ] Add Nix checks/packages so `nix flake check` validates the project.

## P1 — repository operations and security ownership

### 17. Activate and enforce the GitHub setup

- [ ] Enable Actions for the KLM fork and obtain a green run on the current branch.
- [ ] Protect `main` with required deterministic checks and review requirements.
- [ ] Enable Issues or clearly direct contributors to a KLM-owned tracker.
- [ ] Enable private vulnerability reporting.
- [ ] Add repository rulesets and least-privilege workflow permissions.
- [ ] Confirm dependency review, CodeQL, Dependabot/Renovate, release, and SBOM workflows operate in the fork.
- [ ] Add a documented release process and create signed/verified tags where practical.

## P2 — documentation, identity, and product scope

### 18. Regenerate documentation from reality

- [ ] Generate README dataset statistics from the snapshot in CI.
- [ ] Document all 17 adapters and distinguish working, aggregator, manual, and stub adapters.
- [ ] Remove or add the missing `enrich-companies-countries.mjs` reference.
- [ ] Fix the JavaScript import example for supported Node versions.
- [ ] Rewrite `docs/SETUP.md` to clone KLM/OpenJobs, not `santifer/career-ops`.
- [ ] Update Go prerequisites from 1.21 to the actual module requirement or lower the module requirement deliberately.
- [ ] Correct claims that harvesting filters against a CV; current code filters by configured title/location substrings.
- [ ] Make onboarding skip CV/name/email/salary collection for dataset/harvest-only use.
- [ ] Either add the advertised `/career-ops` alias or remove stale alias claims.
- [ ] Update localized READMEs or clearly mark them as legacy Career-Ops documentation.
- [ ] Document output completeness, failure semantics, freshness, and known limitations.

### 19. Reconcile versions and release identity

- [ ] Decide whether OpenJobs and inherited Career-Ops compatibility require separate version numbers.
- [ ] Reconcile `package.json` (`1.0.0`), `VERSION` (`1.3.0`), `.release-please-manifest.json` (`1.5.0`), and the upstream changelog.
- [ ] Change release/SBOM/package names from `career-ops` where appropriate.
- [ ] Update package repository/homepage/author metadata for the chosen canonical owner while preserving attribution.
- [ ] Create a KLM-owned changelog for OpenJobs changes.

### 20. Fix ownership and community links

- [ ] Replace inherited support, issue, governance, and security-reporting destinations with KLM-owned destinations, or explicitly state that upstream owns those surfaces.
- [ ] Do not promise a response from `hi@santifer.io` unless that maintainer has agreed to handle KLM fork reports.
- [ ] Update issue and PR templates so they do not send contributors to unrelated upstream URLs.
- [ ] Clarify the relationship among KLM, Outscal, and Career-Ops.

### 21. Decide whether to split the products

- [ ] Decide whether this repository is primarily:
  - an open jobs dataset and harvester;
  - a full Career-Ops job-application assistant; or
  - a monorepo containing two clearly separated packages/products.
- [ ] If harvester-first, move legacy Career-Ops/Playwright/dashboard functionality behind optional packages or clearly separated directories.
- [ ] If retaining both, give each independent configuration, onboarding, tests, docs, dependencies, and versioning.

The current combined design makes a lightweight harvester install Playwright, makes a generic doctor demand CV/profile setup, and allows the inherited updater/release system to overwrite fork identity.

## Decisions needed before implementation

1. Is `klm-labs/OpenJobs` intended to become the canonical maintained repository, or is this work destined for `outscal/OpenJobs`?
2. Should the product scope be harvester/dataset only, or should the inherited Career-Ops workflow remain first-class?
3. What is the desired output model: immutable run files, merged daily exports, or a persistent job database?
4. What license and provenance policy can be asserted for the company dataset?
5. Should multiple ATS boards per company be harvested concurrently, or should verified current/legacy states select one?
6. Which aggregators/providers may be queried by default under their terms and acceptable-use policies?
7. Who owns security reports, contributor support, releases, and update review for the KLM fork?

## Suggested first implementation slice

A practical first session should be kept narrow and leave the repository safer than it started:

1. Disable `update-system.mjs apply` with a clear explanation while keeping read-only update checks if desired.
2. Fix `.gitignore`/story-bank handling and add a Data Contract ignore test.
3. Make `test-all.mjs` read-only and fix the stale skill assertion.
4. Commit a lockfile, add `npm test`, and establish a green deterministic Node CI run.
5. Then address same-day output/history and Workable dry-run cursor semantics with integration tests.

## Revalidation checklist

After each remediation batch:

```bash
npm test
npm ci
node test-all.mjs --quick
git ls-files 'adapters/*.mjs' | xargs -n1 node --check
cd dashboard && go test -mod=readonly ./... && go test -race ./... && go vet ./... && go build ./...
git status --short --branch
```

Run live ATS smoke tests separately and with small explicit limits. Never make them a requirement for deterministic PR CI.

