# crossref-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `crossref_get_work` | Resolves a DOI to its full Crossref metadata record: title, authors, affiliations, abstract (when deposited), journal/container, publication date, type, license, full-text links, funder acknowledgements, and outgoing reference list. Incoming citation counts (`is-referenced-by-count`) are included but the citing works themselves are not — use OpenAlex for full citation graphs. | `doi` (required) | `readOnlyHint: true`, `idempotentHint: true` |
| `crossref_search_works` | Searches the Crossref works index by free text and/or structured filters. Filters use Crossref's hyphen-separated syntax: `from-pub-date`, `until-pub-date`, `type`, `funder`, `issn`, `member`, `has-abstract`, `has-references`, `has-full-text`, `directory` (DOAJ for open-access). Sort options: `relevance`, `is-referenced-by-count`, `published`, `deposited`, `score`. Results beyond ~10K require cursor-based paging. | `query` (free text), `filter` (object with hyphen-key names), `fields` (select, reduces payload), `rows` (default 20, max 100), `cursor` (`*` for first page, then next-cursor token), `sort`, `order` | `readOnlyHint: true`, `openWorldHint: true` |
| `crossref_get_references` | Returns the outgoing reference list for a DOI — the works cited by this paper. Each reference includes its raw citation string and, where Crossref has resolved it, a DOI for follow-up lookup. Incoming citations (works that cite this paper) are not available through Crossref; use OpenAlex for that. | `doi` (required) | `readOnlyHint: true`, `idempotentHint: true` |
| `crossref_search_journals` | Finds Crossref journal records by ISSN or title query. Returns journal metadata (title, publisher, ISSN-L, subject areas, DOI prefix) plus optionally the journal's most recent works. | `query` (title text) or `issn`, `include_works` (bool, default false), `rows` | `readOnlyHint: true`, `openWorldHint: true` |
| `crossref_search_funders` | Finds funders registered in the Crossref Funder Registry by name or funder DOI, then optionally retrieves works funded by the matched funder. Returns funder name, DOI, country, alternate names, and (when requested) a paginated list of funded works. | `query` (funder name) or `funder_doi`, `include_works` (bool, default false), `rows` | `readOnlyHint: true`, `openWorldHint: true` |

### Input Schema Notes

- **DOI parameter:** validated with a regex pattern (`/^10\.\d{4,9}\/\S+$/`) and described as a string in the format `"10.NNNN/suffix"`. Not a branded type (schema must be JSON-Schema-serializable), but the `.describe()` gives the format with an example.
- **Filter object:** structured as `z.record(z.string())` with `.describe()` listing the valid hyphen-separated keys from the API (`has-abstract`, `has-references`, `has-full-text`, `from-pub-date`, `until-pub-date`, `type`, `funder`, `issn`, `member`, `directory`). Free `z.record(z.string())` is acceptable here because the valid set is large and the API returns an actionable validation error on unknown keys.
- **`fields` parameter (search only):** `z.array(z.string()).optional()` — narrows the fields returned by the search endpoint. Full records can be large; selecting `DOI`, `title`, `author`, `published`, `type`, `is-referenced-by-count` covers most agent workflows. Not available on `/works/{doi}` (single-fetch path).
- **`cursor` parameter (search only):** `z.string().optional()` — pass `"*"` to start cursor-based deep paging (required past ~10K results); pass the `next-cursor` token from each response to continue. Cannot be combined with `offset`.

### Error Contracts

| Tool | Reason | Code | When | Retryable |
|:-----|:-------|:-----|:-----|:----------|
| `crossref_get_work` | `doi_not_found` | `NotFound` | Valid DOI format but no Crossref record | No — verify DOI or try a search |
| `crossref_get_work` | `invalid_doi` | `InvalidParams` | DOI fails regex validation | No — fix format (`10.NNNN/suffix`) |
| `crossref_get_references` | `doi_not_found` | `NotFound` | Valid DOI format but no Crossref record | No |
| `crossref_get_references` | `invalid_doi` | `InvalidParams` | DOI fails regex validation | No |
| `crossref_get_references` | `no_references` | `NotFound` | Record exists but has no indexed reference list | No — coverage varies by publisher |
| `crossref_search_works` | `cursor_offset_conflict` | `InvalidParams` | Both `cursor` and `offset` supplied | No — use one or the other |
| `crossref_search_works` | `offset_too_large` | `InvalidParams` | `offset + rows > ~10K` without cursor | No — switch to `cursor=*` for deep paging |
| All | `rate_limited` | `ServiceUnavailable` | 429 or 503 from Crossref | Yes — retry with backoff |

### `format()` Notes

Both surfaces (`structuredContent` from `output` and `content[]` from `format()`) must carry the same data. `format()` is not a count/title stub — it must render title, authors, DOI, abstract (or "not deposited"), reference count, license, and the full reference list with resolved DOIs where available. Large reference lists should be truncated with a "…and N more" note in `format()` but the full list must be in `structuredContent`.

### Resources

No resources defined. All data is accessible through the tool surface; Crossref records are live-fetched and not suitable as stable injectable URIs.

### Prompts

No prompts defined. This is a data retrieval server; recurring patterns are covered by tool descriptions.

---

## Overview

crossref-mcp-server wraps the Crossref REST API to expose canonical scholarly metadata for ~155 million registered works (journal articles, books, chapters, conference papers, preprints, datasets, components). It is the authoritative source for DOI-registered metadata — titles, authors, affiliations, abstracts (where deposited), licenses, full-text links, funder acknowledgements, and outgoing reference lists. It does not provide incoming citation counts or citation graphs; those belong to OpenAlex.

**Pairs with:** pubmed-mcp-server (biomedical-specific abstracts/MeSH), openalex-mcp-server (analytics, citation graphs, topics, concepts), arxiv-mcp-server (preprints — their DOIs resolve through Crossref), biorxiv-mcp-server (preprints — same).

---

## Requirements

- Read-only. No writes to Crossref.
- All requests include a polite-pool `User-Agent` header (`crossref-mcp-server/0.1.0 (mailto:<CROSSREF_MAILTO>)`) when `CROSSREF_MAILTO` is set. The env var is optional — without it the server starts but uses the anonymous pool with stricter rate limits. No token is required — polite-pool access is granted solely via the mailto User-Agent.
- Offset paging is capped at ~10K results per query. Results beyond that require cursor-based paging (`cursor=*` to start, then pass the `next-cursor` value from each response). Mixing `cursor` and `offset` is not supported.
- Filter keys use hyphens (`has-abstract`, `has-references`, `has-full-text`, `from-pub-date`, `until-pub-date`). There is no `is_open_access` filter; use `directory:DOAJ` to restrict to DOAJ-indexed open-access content.
- The `select` field parameter works on `/works` (search) only. It is not supported on `/works/{doi}` (single record fetch).
- Outgoing reference lists are only available for works where Crossref has indexed them; coverage varies by publisher.
- Abstracts are deposited at publisher discretion; many records lack them.
- `has-full-text` filter returns works with registered full-text links — access may still require a subscription.
- Incoming citations are not exposed by Crossref. Attempts to retrieve them must be redirected to OpenAlex.

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:---------|
| `CrossrefService` | Crossref REST API (`https://api.crossref.org/`) | All five tools |

### CrossrefService design

- Singleton, initialized in `setup()`, accessed via `getCrossrefService()`.
- Injects polite-pool `User-Agent` on every request from config.
- `fetchWithTimeout` for all HTTP; non-OK → `ServiceUnavailable`.
- `withRetry`: 3 attempts, 1s base delay (rate-limit recovery), exponential backoff. HTML error-page detection throws transient, not `SerializationError`.
- Field selection: `select=` works on `/works` (search) only — not on `/works/{doi}`. For `crossref_get_references`, fetch the full record from `/works/{doi}` and extract the `reference` field from the response body rather than using a select shortcut.
- Pagination: offset is capped at `total-results - rows` (hard limit ~10K). For deep paging, use `cursor=*` on the first request, then pass the `next-cursor` token from each response as the `cursor` parameter. Cursor and offset cannot be used together. Throw when offset is requested past the limit and cursor was not supplied.
- Retry: 3 attempts, 1s base delay, exponential backoff. Both 429 and 503 may appear under load and are retryable.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `CROSSREF_MAILTO` | No | Email address embedded in the polite-pool `User-Agent` header. Optional — server starts without it but logs a warning and uses the anonymous pool with stricter rate limits. |
| `CROSSREF_BASE_URL` | No | Override API base URL. Defaults to `https://api.crossref.org`. Useful for testing against a local proxy. |
| `CROSSREF_TIMEOUT_MS` | No | Per-request timeout in milliseconds. Default: `10000`. |

---

## Implementation Order

1. **Config** — `src/config/server-config.ts`: Zod schema for the four env vars above. Warn at startup if `CROSSREF_MAILTO` is absent.
2. **CrossrefService** — `src/services/crossref-service.ts`: HTTP client with polite-pool User-Agent, retry, timeout, and pagination helpers.
3. **`crossref_get_work`** — simplest tool; validates DOI format, fetches `/works/{doi}`, returns full record.
4. **`crossref_get_references`** — fetches `/works/{doi}` (full record), extracts `reference[]` from the response body; structured per-ref output with resolved DOIs where present.
5. **`crossref_search_works`** — search with filter mapping and cursor-based deep paging for large result sets.
6. **`crossref_search_journals`** — `/journals` query + optional `/journals/{issn}/works` follow-up.
7. **`crossref_search_funders`** — `/funders` query + optional `/funders/{funder_doi}/works` follow-up.

Each step is independently testable; steps 3–7 build on the service from step 2.

---

## Domain Mapping

| Noun | Crossref Endpoint(s) | Tool(s) |
|:-----|:---------------------|:--------|
| Work | `GET /works/{doi}`, `GET /works?query=…&cursor=*` | `crossref_get_work`, `crossref_search_works` |
| Work references | `GET /works/{doi}` → extract `reference[]` | `crossref_get_references` |
| Journal | `GET /journals?query=…`, `GET /journals/{issn}` | `crossref_search_journals` |
| Journal works | `GET /journals/{issn}/works` | `crossref_search_journals` (with `include_works`) |
| Funder | `GET /funders?query=…`, `GET /funders/{id}` | `crossref_search_funders` |
| Funder works | `GET /funders/{id}/works` | `crossref_search_funders` (with `include_works`) |
| Member | — | Not exposed (publisher admin detail; low agent value) |
| Type | — | Not exposed (enum used as a filter value; no dedicated tool warranted) |

---

## Workflow Analysis

**`crossref_search_journals` with `include_works: true`** (2 upstream calls):

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /journals?query=…` or `GET /journals/{issn}` | Resolve journal, return metadata |
| 2 | `GET /journals/{issn}/works` | Fetch recent works for matched journal |

Both calls run sequentially (step 2 depends on ISSN from step 1). Step 2 is only made when `include_works: true`.

**`crossref_search_funders` with `include_works: true`** (2 upstream calls):

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /funders?query=…` or `GET /funders/{id}` | Resolve funder, return metadata |
| 2 | `GET /funders/{id}/works` | Fetch funded works for matched funder |

Same sequential pattern; step 2 only on `include_works: true`.

No multi-hop reference traversal. `crossref_get_references` returns a single hop. Agents that need N-hop traversal chain the tool explicitly — this keeps individual calls bounded and lets the agent decide the depth.

---

## Known Limitations

- **No incoming citations.** Crossref does not expose which works cite a given DOI. For citation counts, incoming references, or citation graphs, use OpenAlex.
- **Abstract coverage is incomplete.** Abstracts are deposited voluntarily by publishers. Many records — especially older works, books, and non-OA journal content — have no abstract.
- **Reference list coverage varies.** Outgoing reference lists are only present for works whose publishers participate in Crossref's reference-linking program. Pre-2000 literature has low coverage.
- **Full-text links ≠ open access.** `has-full-text` means a full-text URL is registered; access may still require a subscription. To restrict to genuinely open-access content, use `directory:DOAJ` (limits to DOAJ-indexed journals). There is no universal `is_open_access` filter in the Crossref API.
- **`crossref_search_works` sort options are fixed.** Valid values: `relevance`, `score`, `is-referenced-by-count` (citation count), `published`, `published-print`, `published-online`, `deposited`, `indexed`, `created`, `updated`, `references-count`. Arbitrary field-level sort is not supported.
- **Rate limits are soft.** The polite pool provides priority access but not guaranteed throughput. High-volume batch workflows should space requests.

---

## Decisions Log

### Answered questions

- **Polite-pool mailto — env var or hardcoded server contact?** → `CROSSREF_MAILTO` env var. Rationale: server operators may differ from the codebase author; env var lets each deployment supply its own contact without a code change.
- **Citation graph traversal — multi-hop or single-hop?** → Single-hop only (`crossref_get_references` returns one level). Rationale: multi-hop traversal with configurable depth grows O(N^k) in upstream calls, burns rate-limit budget, and the agent already has the DOIs it needs to chain calls itself. Let the agent decide traversal depth.
- **DataCanvas for large search result sets?** → Initially yes (opt-in via `CANVAS_PROVIDER_TYPE=duckdb`), later removed. Rationale: the spillover was wired in but no `dataframe_query`/`dataframe_describe` consumer tool was ever added, so the `canvas_id` handle was dead output. Crossref works are categorical bibliographic metadata — the workflow is search-then-resolve-a-DOI, not aggregate-over-rows — so the integration was removed rather than completed.
- **Incoming citations — expose a tool?** → No. Crossref genuinely does not provide this data; there is nothing to wrap. Documented in Known Limitations and reflected in `crossref_get_references` description so agents know not to try.
- **`crossref_search_journals` and `crossref_search_funders` — separate tools or modes of one tool?** → Separate tools. Rationale: journals and funders are distinct entity types with different search fields, output shapes, and follow-up patterns; consolidating under a `mode` enum would obscure the difference rather than reduce surface.
- **Member and Type endpoints — expose as tools?** → No. Members (publishers) are administrative detail with low agent-workflow value; Type is an enum used as a filter input, not a queryable entity.
- **Resources — add any?** → No. Crossref records are live-fetched; there are no addressable stable URIs the server owns. Tool surface is self-sufficient.

### Options declined

- **Multi-hop `crossref_get_references` with a `depth` parameter** → Declined. Exponential upstream call growth per hop, unbounded latency, and rate-limit risk disproportionate to the use case. Agent chaining is the right model.
- **`crossref_get_member` tool** → Declined. Publisher administrative metadata (member records) has minimal agent utility and would widen the surface with low-value data.
- **`crossref_list_types` tool** → Declined. Work types are a closed enum (journal-article, book, book-chapter, etc.) better represented as an inline enum in `crossref_search_works`'s filter schema than as a separate tool call.
- **App tools** → Declined. No real-time human-in-the-loop interaction with Crossref data warrants the iframe/CSP overhead.
- **Instruction tool** → Declined. No recurring "how do I do X given my current state" pattern; this is a straightforward data-retrieval server.
- **Prompt templates** → Declined. Interaction patterns are not complex or recurring enough to warrant reusable prompts.

### Corrections from API verification (v0.1 → v0.2)

These items were wrong in the initial design. All were verified against the live API.

- **`select=` on `/works/{doi}` does not exist.** The API returns `parameter-not-allowed`. `select` works only on `/works` (search). `crossref_get_references` must fetch the full record from `/works/{doi}` and extract `reference[]` client-side — no shortcut is available.
- **Offset paging is capped at ~10K.** Requests with `offset + rows > total-results` (and approximately > 10K absolute) return a 400 validation error: "Use the cursor parameter to page further into result sets." The design's statement "Crossref uses `offset`/`rows` (not cursor)" was incorrect. Deep paging requires `cursor=*` on the first request, then chaining `next-cursor` tokens. `cursor` and `offset` cannot be combined.
- **`is_open_access` / `is-oa` filter does not exist.** The live API returned `filter-not-available` for `is-oa`. For open-access filtering, use `directory:DOAJ` (value must be uppercase `DOAJ`). There is no universal OA flag in the filter syntax.
- **Filter keys use hyphens, not underscores.** e.g. `has-abstract`, `has-references`, `has-full-text`, `from-pub-date`. The design's filter object description used underscore variants (`has_abstract`, `is_open_access`) which would produce API validation errors.
- **Sort field for citation ranking is `is-referenced-by-count`**, not "citation count". Additional valid sort fields: `score`, `relevance`, `published`, `published-print`, `published-online`, `deposited`, `indexed`, `created`, `updated`, `references-count`.
- **Tool description leakage fixed.** `crossref_get_work` original description included "prefer `crossref_get_references`" — meta-coaching directing the consumer. Removed. The incoming citations scope boundary is now stated as a fact ("use OpenAlex for full citation graphs") rather than a directive.
- **Error contracts, `format()` requirements, DOI validation, `fields`/`cursor` parameters** were absent from the initial design. Added under Input Schema Notes, Error Contracts, and `format()` Notes sections.
