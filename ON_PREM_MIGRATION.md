# On-Premises Migration Plan

## Current state (development/test only)

The backend (`server/`) uses SQLite via `better-sqlite3`, a single file at
`server/data/rsk.sqlite3` by default (configurable via `RSK_DB_PATH`). This is
**explicitly a development/test choice**, not a validated production database.
`JEWELLERY_TECHNICAL_SPEC.md` requires this to never be claimed as the eventual
production provider.

`TODO(ON_PREM_DB)`: the approved on-premises database engine and version have
not been specified by the business owner. Nothing below should be read as a
recommendation to keep SQLite in production.

## Why SQLite was chosen for now

- Zero extra services to run during development; matches the project's existing
  "no build step, run it directly" philosophy.
- Real SQL, real transactions, real constraints — so business logic written
  against it is not throwaway: the same SQL (minus any SQLite-specific syntax)
  is expected to need only moderate adaptation for the eventual engine.
- `better-sqlite3` is synchronous and transactional, which keeps the
  multi-table financial operations required by the spec (§6.2, §6.3) simple to
  reason about and test.

## SQLite-specific behavior to re-verify on the production provider

- `PRAGMA foreign_keys = ON` and `PRAGMA journal_mode = WAL` are set in
  `server/src/db/connection.js`. WAL mode is a SQLite concept with no direct
  analog in some engines; re-verify equivalent durability/concurrency settings.
- SQLite has no native `DECIMAL`/fixed-point type; once money/weight columns
  are introduced (Phase 2+), the plan is scaled integers (e.g. minor units) or
  text-encoded decimals validated at the boundary — this must be re-checked
  against the target engine's native decimal support, which may allow a
  simpler representation.
- SQLite's locking model is file-level, not row-level. Concurrency tests run
  against SQLite in Phase 3+ (concurrent stock-sale attempts) **must be
  re-run against the production engine**; a passing SQLite test does not prove
  correct behavior under real concurrent load.
- `AUTOINCREMENT` / `strftime` default timestamps are SQLite syntax; migrations
  will need an equivalent rewrite, not a direct copy, for another engine.

## Migration plan outline (to be completed once the engine is approved)

1. Record the approved engine, version, and hosting details here.
2. Re-express `server/src/db/migrations/*.sql` for that engine's dialect
   (or introduce a migration tool appropriate to it).
3. Re-run the full integration/concurrency test suite against the new engine
   before any cutover.
4. Build an export/import path from the SQLite dev database's schema-equivalent
   data (seed/demo data is not migrated — only confirmed real business data from
   actual usage would be, and only after the owner defines provenance for any
   pre-existing/opening stock figures per §5 "Schema rules").
5. Document backup schedule, encrypted off-site copy, retention, and a tested
   restore procedure (`TODO(OWNER_POLICY)` for retention length).

## Future on-premises operational requirements (not yet addressed)

- Server OS, runtime, deployment method, and update process — undecided.
- Private LAN access only; no public database exposure; VPN for remote access
  if required — undecided.
- Secrets/credential handling for the production environment — undecided
  beyond "never commit secrets" (enforced via `.gitignore` + `.env.example`
  pattern already in use in `server/`).
- TLS termination — undecided.
- Automated backup schedule and restore test — undecided.
- UPS/power-failure handling — undecided.
- Monitoring/logging and disk-space alerts — undecided.
- Disaster-recovery steps and a documented recovery test — undecided.

**This system must not be described as production-ready until the items above
are resolved and the migration plan in this document has actually been
executed and verified**, per `JEWELLERY_TECHNICAL_SPEC.md` §13.
