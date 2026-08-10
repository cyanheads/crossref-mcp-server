# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.3.9](changelog/0.3.x/0.3.9.md) — 2026-08-09

crossref_get_work's publication-date fallback now matches the three search tools instead of stopping early on a source naming no date

## [0.3.8](changelog/0.3.x/0.3.8.md) — 2026-08-09

Crash fix for ROR-only funders/affiliations and null date components; content[] now escapes Markdown; JATS <alternatives> formula dedup

## [0.3.7](changelog/0.3.x/0.3.7.md) — 2026-08-09

Unified JATS/reference markup strip; refersplit, valueless attributes, MathML duplication, and link-tag address loss fixed

## [0.3.6](changelog/0.3.x/0.3.6.md) — 2026-08-09

crossref_get_references markup strip rewritten (tag shape, MathML/JATS citation regions), full HTML5 named entity set

## [0.3.5](changelog/0.3.x/0.3.5.md) — 2026-08-09

Author list paging/cap on crossref_get_work and crossref_search_works, reference markup stripped via element-name allow-list

## [0.3.4](changelog/0.3.x/0.3.4.md) — 2026-08-09

Free-text output normalized (JATS markup, entities), funder deprecation notices, dead countryCode field removed

## [0.3.3](changelog/0.3.x/0.3.3.md) — 2026-08-06

crossref_search_works cursor walks terminate correctly; blank cursor normalized

## [0.3.2](changelog/0.3.x/0.3.2.md) — 2026-08-06

Cursor paging on journal/funder works lists, faster failure on a request-timeout deadline

## [0.3.1](changelog/0.3.x/0.3.1.md) — 2026-08-07

Upstream and transport failures from Crossref now classify by wire code instead of by accident, and every upstream reason carries a recovery hint on content[] as well as structuredContent

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-08-06 · ⚠️ Breaking

crossref_search_journals and crossref_search_funders page both the name-search and works lists by offset; crossref_search_funders rejects ambiguous include_works targets instead of silently picking one; funder_doi accepts bare registry IDs

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-08-06

crossref_search_works force-includes DOI in select= and stops capping author lists at 10; crossref_get_references pages instead of truncating content[]; crossref_get_member scales coverage precision so small fractions don't round to 0%

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-07-13

crossref_get_member resolves a member ID to its publisher record (DOI prefixes, counts, deposit coverage); crossref_get_prefix resolves a DOI prefix to its owning member

## [0.1.17](changelog/0.1.x/0.1.17.md) — 2026-07-13

Field-specific search-works query params (title/author/container-title/bibliographic); journal and funder works sorted most-recent-first; README/design.md accuracy fixes; mcp-ts-core ^0.10.14 with Socket install-scanning and Docker build hardening

## [0.1.16](changelog/0.1.x/0.1.16.md) — 2026-06-20

Adopt @cyanheads/mcp-ts-core ^0.10.9; re-sync 14 skills + 6 devcheck scripts; devcheck gains dependency-specifier and plugin-manifest packaging guards

## [0.1.15](changelog/0.1.x/0.1.15.md) — 2026-06-15

Server-level instructions on createApp(); plugin display identity unscoped to crossref-mcp-server; @biomejs/biome ^2.5.0, vitest ^4.1.9

## [0.1.14](changelog/0.1.x/0.1.14.md) — 2026-06-11

Maintenance: @cyanheads/mcp-ts-core ^0.9.21 → ^0.10.6; explicit name/title identity pair; Dockerfile image.version + HEALTHCHECK; root-anchored .mcpbignore; post-pack bundle cleaner; packaging and antipattern linter checks; skill sync

## [0.1.13](changelog/0.1.x/0.1.13.md) — 2026-06-04

crossref_get_references returns structured empty data instead of throwing; ISSN and funder_doi validated at the tool boundary; CROSSREF_TIMEOUT_MS now enforced per-request

## [0.1.12](changelog/0.1.x/0.1.12.md) — 2026-06-02

Adopt @cyanheads/mcp-ts-core ^0.9.21 — per-request log context fix, secret-stripping in error messages, withRetry fail-fast on non-retryable errors

## [0.1.11](changelog/0.1.x/0.1.11.md) — 2026-05-31

Remove DataCanvas integration from crossref_search_works — canvas_id input, canvas output block, spillover logic, and the canvas-accessor service

## [0.1.10](changelog/0.1.x/0.1.10.md) — 2026-05-30

Enrichment adoption: search tools surface result totals, query echo, and empty-result guidance in a typed enrichment block

## [0.1.9](changelog/0.1.x/0.1.9.md) — 2026-05-28

@cyanheads/mcp-ts-core ^0.9.9 → ^0.9.13: HTTP body cap, session-init gate, quieter 4xx logs, GET /mcp keywords, MCPB placeholder fix

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-05-24

Code simplification: shared parseDateParts/formatDateParts/normalizeFunderId helpers; mcp-ts-core ^0.9.6 → ^0.9.9; ambiguous_journal error code InvalidParams → ValidationError

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-05-24

Fix crossref_search_funders worksCount always null; replace InternalError with typed ctx.fail in crossref_search_journals ambiguity path

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-05-23

Field-test bug fixes: error handling, data mapping, validation, and formatting across all five Crossref tools

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-05-23

Pre-launch polish: type-safe error handling, .describe() on output schemas, AGENTS.md, Dockerfile OCI labels, bunfig.toml

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-05-23

field-test bug fixes: JATS stripping, null type handling, 404 recovery, filter docs, nextCursor naming

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-05-23

mcp-ts-core ^0.9.5 → ^0.9.6, LICENSE added, lint-packaging and skill updates

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-05-23

mcp-ts-core ^0.9.5, error code semantic fixes (invalid_doi/cursor_offset_conflict → ValidationError), MCPB bundle support

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-05-21

Full tool surface: DOI resolution, reference extraction, works search, journal and funder lookup

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-21

Initial scaffold from @cyanheads/mcp-ts-core; tool-surface design for Crossref REST API.
