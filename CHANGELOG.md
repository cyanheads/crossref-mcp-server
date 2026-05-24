# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

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
