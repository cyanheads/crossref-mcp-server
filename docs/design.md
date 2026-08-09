# crossref-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `crossref_get_work` | Resolves a DOI to its full Crossref metadata record: title, authors, affiliations, abstract (when deposited), journal/container, publication date, type, license, full-text links, funder acknowledgements, and outgoing reference count. The reference entries themselves come from `crossref_get_references`. Incoming citation counts (`is-referenced-by-count`) are included but the citing works themselves are not — use OpenAlex for full citation graphs. | `doi` (required) | `readOnlyHint: true`, `idempotentHint: true` |
| `crossref_search_works` | Searches the Crossref works index by free text and/or structured filters. Filters use Crossref's hyphen-separated syntax: `from-pub-date`, `until-pub-date`, `type`, `funder`, `issn`, `member`, `has-abstract`, `has-references`, `has-full-text`, `directory` (DOAJ for open-access). Sort options: `relevance`, `is-referenced-by-count`, `published`, `deposited`, `score`. Results beyond ~10K require cursor-based paging, which ends on the page that omits `nextCursor`. | `query` (free text), `filter` (object with hyphen-key names), `fields` (select, reduces payload), `rows` (default 20, max 100), `cursor` (`*` for first page, then nextCursor token), `sort`, `order` | `readOnlyHint: true`, `openWorldHint: true` |
| `crossref_get_references` | Returns the outgoing reference list for a DOI — the works cited by this paper. Each reference includes its raw citation string and, where Crossref has resolved it, a DOI for follow-up lookup. Paged: `referenceCount` is the full deposited total and `nextOffset` enrichment carries the input for the next page. Incoming citations (works that cite this paper) are not available through Crossref; use OpenAlex for that. | `doi` (required), `offset` (default 0), `limit` (default 100, max 500) | `readOnlyHint: true`, `idempotentHint: true` |
| `crossref_search_journals` | Finds Crossref journal records by ISSN or title query. Returns journal metadata (title, publisher, ISSN-L, subject areas, total DOI count) plus optionally a page of the journal's most recent works. The journal list and the works list page independently; the works list pages by offset or by cursor. | `query` (title text) or `issn`, `include_works` (bool, default false), `rows`, `offset` (journal list), `works_offset` / `works_cursor` (works list) | `readOnlyHint: true`, `openWorldHint: true` |
| `crossref_search_funders` | Finds funders registered in the Crossref Funder Registry by name, bare registry ID, or funder DOI, then optionally retrieves a page of works funded by the matched funder. Returns funder name, registry ID, country, and alternate names. The funder list and the funded-works list page independently; the funded-works list pages by offset or by cursor. | `query` (funder name) or `funder_doi`, `include_works` (bool, default false), `rows`, `offset` (funder list), `works_offset` / `works_cursor` (funded-works list) | `readOnlyHint: true`, `openWorldHint: true` |
| `crossref_get_member` | Resolves a Crossref member ID to its publisher/organization record: primary name, alternate imprint names, owned DOI prefixes, DOI counts (total/current/backfile), per-work-type breakdown, and per-category metadata deposit coverage (references, abstracts, ORCIDs, funders, licenses, etc.) as current/backfile fractions plus the two summary deposit flags. | `member_id` (required, positive integer) | `readOnlyHint: true`, `idempotentHint: true` |
| `crossref_get_prefix` | Resolves a DOI prefix (the registrant portion, e.g. `10.1038`) to its owning member: publisher name and numeric member ID. The member ID chains into `crossref_get_member`. The upstream prefix record is thin — three fields, all reflected honestly. | `prefix` (required, `10.NNNN`) | `readOnlyHint: true`, `idempotentHint: true` |

### Input Schema Notes

- **DOI parameter:** validated with a regex pattern (`/^10\.\d{4,9}\/\S+$/`) and described as a string in the format `"10.NNNN/suffix"`. Not a branded type (schema must be JSON-Schema-serializable), but the `.describe()` gives the format with an example.
- **Filter object:** structured as `z.record(z.string())` with `.describe()` listing the valid hyphen-separated keys from the API (`has-abstract`, `has-references`, `has-full-text`, `from-pub-date`, `until-pub-date`, `type`, `funder`, `issn`, `member`, `directory`). Free `z.record(z.string())` is acceptable here because the valid set is large and the API returns an actionable validation error on unknown keys.
- **`fields` parameter (search only):** `z.array(z.string()).optional()` — narrows the fields returned by the search endpoint. Full records can be large; selecting `DOI`, `title`, `author`, `published`, `type`, `is-referenced-by-count` covers most agent workflows. Not available on `/works/{doi}` (single-fetch path). `CrossrefService.searchWorks` force-includes `DOI` in the `select=` projection whether or not the caller lists it — DOI is the work summary's only identifier and the sole key that chains into the other tools, so a projection that drops it yields unresolvable records. Crossref's select names are case-sensitive (`DOI` valid, `doi` rejected as `select-not-available`), so the dedupe matches exactly rather than case-insensitively; a miscased name still surfaces the upstream validation error naming it.
- **`offset` / `limit` parameters (`crossref_get_references`):** page the deposited reference list. Reference lists are heavy-tailed — most works deposit none at all, and among those that do a sampled median is 28 references — but bibliography records reach far higher: `10.1016/b978-0-12-397189-0.00123-3` carries 25,814, a 5 MB `structuredContent` payload if returned whole. Paging bounds both result paths identically rather than bounding only the rendered one.
- **`cursor` parameter (search only):** `z.string().optional()` — pass `"*"` to start cursor-based deep paging (required past ~10K results); pass the `nextCursor` token from each response to continue, until a response omits it. `/works` keeps minting a `next-cursor` past the end of a list — and hands back the very token that produced the empty page, so an unguarded walk re-sends it forever — so `nextCursor` is withheld once a page comes back empty rather than relayed. That page also carries a `notice` stating the walk is complete: the tool's whole payload is `works`, so an empty page nothing is said about renders as blank text for a client reading `content[]`. Cannot be combined with `offset`. A blank `cursor` is read as absent, as `works_cursor` is on the two sub-resource lists: form-based clients send `""` for an optional field nobody filled in, and the service picks its selector by truthiness, so a blank never reaches Crossref and the page arrives through the offset path. Normalizing at the top of the handler is what keeps the guards below reading the value the request will actually carry — otherwise the conflict guard refuses an `offset` that has no cursor to conflict with, and the empty-page notice calls an offset page a completed walk.
- **`offset` / `works_offset` parameters (`crossref_search_journals`, `crossref_search_funders`):** each tool returns two independent lists — the name-search matches and, under `include_works`, the matched record's works — so each gets its own offset input and its own `nextOffset` / `nextWorksOffset` continuation. Crossref's ceiling is not uniform across the two: `/journals` and `/funders` name search accept `offset + rows` up to 100,000, while `/journals/{issn}/works` and `/funders/{id}/works` cap ten times lower at 10,000. Both ceilings are enforced in the handler ahead of the upstream call (`offset_too_large`, `works_offset_too_large`), and a continuation offset is withheld when the following page would breach the ceiling rather than handed out for Crossref to reject — paired with a `notice` on that page, because a withheld offset and an exhausted list otherwise look identical.
- **`works_cursor` parameter (`crossref_search_journals`, `crossref_search_funders`):** the works sub-resources also accept `cursor`, which has no ceiling, so `works_cursor="*"` starts a walk of the whole works list and the `nextWorksCursor` enrichment carries the token for the page after. It is the deep-paging path for both tools: the alternative — `crossref_search_works` with an `issn:` / `funder:` filter — costs a tool switch mid-pagination and, on funders, silently changes the result set, since `/funders/{id}/works` rolls in the funder's registry descendants and the `funder:` filter does not. Cursor and offset are alternatives, not a pair: Crossref rejects the combination with `cursor-with-offset-or-sample`, and the handler refuses it first as `works_cursor_offset_conflict`. That guard keys on whether an offset would actually be spent (`works_offset > 0`) rather than on whether the field arrived, because `works_offset` carries a schema default of 0 that is indistinguishable from an omitted field — and 0 is the start of the list, never transmitted, so pairing it with a cursor discards nothing. A cursor walk cannot resume from an offset; it always restarts at the newest work, which the ceiling `notice` states outright and the `works_offset_too_large` recovery carries as "restart". A blank `works_cursor` is read as absent rather than as a cursor: form-based clients send `""` for an optional field nobody filled in, and taking that as a cursor selects the cursor path with nothing to send — the request then carries neither selector, Crossref answers page one with no `next-cursor`, and the response withholds the continuation offset too, so a 446,507-work list reads as exhausted after three records. The token itself is ~1500 characters and rides both result surfaces on every page. Crossref sets that and it cannot be shortened, but it is a fixed cost per page rather than per record, so the `works_cursor` description says to raise `rows` on a long walk instead of leaving the arithmetic to the caller.
- **`funder_doi` parameter (`crossref_search_funders`):** accepts the bare Funder Registry ID (`100000001`), the full DOI (`10.13039/100000001`), or the full DOI behind a `doi:` / `https://doi.org/` prefix. `GET /funders/{id}` resolves all three, so the validator admits every form Crossref does; the prefixes are stripped before the request. `doi:100000001` and other prefix-without-stem shapes stay rejected — the prefixes only ever precede the `10.13039/` stem.

### Error Contracts

Declared `errors: [...]` contract entries, one row per reason a handler can throw via `ctx.fail`:

| Tool | Reason | Code | When | Retryable |
|:-----|:-------|:-----|:-----|:----------|
| `crossref_get_work` | `doi_not_found` | `NotFound` | Valid DOI format but no Crossref record | No — verify DOI or try a search |
| `crossref_get_references` | `doi_not_found` | `NotFound` | Valid DOI format but no Crossref record | No — verify DOI or try a search |
| `crossref_search_works` | `cursor_offset_conflict` | `ValidationError` | Both `cursor` and `offset` supplied | No — use one or the other |
| `crossref_search_works` | `offset_too_large` | `ValidationError` | `offset + rows > ~10K` without cursor | No — switch to `cursor=*` for deep paging |
| `crossref_search_journals` | `issn_not_found` | `NotFound` | ISSN lookup returned 404 — not registered in Crossref | No — verify the ISSN or search by title |
| `crossref_search_journals` | `ambiguous_journal` | `ValidationError` | `include_works` with a title query matching more than one journal | No — re-run with one of the ISSNs the error names |
| `crossref_search_journals` | `offset_too_large` | `ValidationError` | `offset + rows > 100000` on journal title search | No — narrow the title query |
| `crossref_search_journals` | `works_offset_too_large` | `ValidationError` | `works_offset + rows > 10000` on the journal works list | No — restart the works list with `works_cursor="*"` |
| `crossref_search_journals` | `works_cursor_offset_conflict` | `ValidationError` | `works_cursor` supplied with a `works_offset` above zero | No — page the works list one way or the other |
| `crossref_search_funders` | `funder_not_found` | `NotFound` | Funder DOI not in the Crossref Funder Registry | No — verify the funder DOI or search by name |
| `crossref_search_funders` | `ambiguous_funder` | `ValidationError` | `include_works` with a name query matching more than one funder | No — re-run with one of the registry IDs the error names |
| `crossref_search_funders` | `offset_too_large` | `ValidationError` | `offset + rows > 100000` on funder name search | No — narrow the name query |
| `crossref_search_funders` | `works_offset_too_large` | `ValidationError` | `works_offset + rows > 10000` on the funded-works list | No — restart the funded-works list with `works_cursor="*"` |
| `crossref_search_funders` | `works_cursor_offset_conflict` | `ValidationError` | `works_cursor` supplied with a `works_offset` above zero | No — page the funded-works list one way or the other |
| `crossref_get_member` | `member_not_found` | `NotFound` | No Crossref member for the given ID | No — verify the ID or resolve it via `crossref_get_prefix` |
| `crossref_get_prefix` | `prefix_not_found` | `NotFound` | DOI prefix not registered in Crossref | No — verify the prefix or search for the work |

Four more reasons are declared on **every** tool, spread from `UPSTREAM_ERROR_CONTRACT` in `src/services/crossref/upstream-errors.ts`. Each tool reaches Crossref through the one shared service, so each can raise all four; a contract listing only a tool's own input-shape failures under-reports what a caller has to handle.

| Reason | Code | When | Retryable |
|:-------|:-----|:-----|:----------|
| `rate_limited` | `RateLimited` (`-32003`) | HTTP 429 the retry budget could not clear | Yes — after the wait the hint quotes from `Retry-After` |
| `upstream_unavailable` | `ServiceUnavailable` (`-32000`) | Network failure, 5xx, an HTML error page served as JSON, or an empty 200 body | Yes — retried with backoff before it surfaces |
| `malformed_response` | `SerializationError` (`-32070`) | HTTP 200 with a non-empty body that is not valid JSON | No — `retryable: false`, fails on the first attempt |
| `request_timeout` | `Timeout` (`-32004`) | No response within `CROSSREF_TIMEOUT_MS`, or a 408/504 | Split — a 408/504 is retried with backoff; a deadline expiry fails on the first attempt |

Every one of them carries `data.recovery.hint`, which the framework mirrors into `content[]` as a `Recovery:` line. That is the only route by which a content-only client learns what to do next — `error.data` reaches `structuredContent` alone, so a 429 whose wait is recorded only in `data.retryAfter` is invisible to half the client population. The rate-limit hint therefore quotes the raw `Retry-After` value in its text.

Two edges the `Retryable` column smooths over. A 429 asking for a wait longer than `withRetry`'s `maxDelayMs` is surfaced immediately rather than burning attempts on a window that cannot open in time, so it can arrive having spent one attempt, not four. And a 429 that names no `Retry-After` at all falls back to the contract's own `recovery` text, which is written for exactly that case — it quotes no interval and points at no `retryAfter` field, because on this path neither exists.

`request_timeout` covers two failures whose retry economics differ, and the split lives at the throw site rather than on the contract entry. A 408 or 504 arrives as fast as Crossref answers, so an attempt costs what any other transient status costs and the entry stays retryable. A deadline expiry costs a full `CROSSREF_TIMEOUT_MS` per attempt because this server's own clock sets it, so that throw site passes `retryable: false` and the call fails on its first attempt.

Two failure classes sit outside the contract:

- **Schema rejection.** A malformed `doi`, `prefix`, or `member_id` fails its Zod validator before the handler runs and surfaces as JSON-RPC `InvalidParams` (`-32602`), not a contract reason. The validator's `message` carries the format and an example.
- **Crossref rejecting the request.** A 400 (`filter-not-available`, `select-not-available`, `integer-not-valid`) surfaces as `ValidationError` (`-32007`) carrying Crossref's own message, with the hyphenated spelling of the offending filter key when the body names one. It is the caller's to fix, so it is never retried and never re-labelled as an upstream reason.

An empty result is not an error. `crossref_get_references` returns a success with an empty `references` array and a `notice` enrichment in two cases — the work has no indexed reference list, and the requested `offset` is past the end of the list — with a distinct notice for each so a caller reading only `content[]` can tell them apart. The search tools carry the same two-notice split: an `offset` past the end of a match list (but within the route's ceiling) is a well-formed empty page with the total still reported, and its notice names the offset and the total rather than repeating the no-match text — a caller told "nothing matched" when 223 records did would go rewrite a query that was fine.

**Ambiguity is refused, never guessed.** `include_works` on either search tool resolves exactly one record. When a name query matches several, the tool throws (`ambiguous_journal` / `ambiguous_funder`) rather than reaching for a match — an embedded works list carries no identifier of its own, so a silently-chosen source is indistinguishable from the right one at the client. The test is the upstream `total-results`, not the length of the returned page: `rows: 1`, or an `offset` landing on the tail of a list, yields a one-record page that identifies nothing the caller chose, and guarding on page length would let exactly the silent pick back in through that door.

The refusal is only useful if recovery is reachable from what the client already has, so each candidate's stable identifier is written into the error *message text* as well as into `candidates` on `error.data` — content-only clients see `Error: <message>` and nothing else, so an identifier that lives only in structured data leaves them needing an undocumented exploratory call. Those candidates are one page of the matches, so the message states the full match count separately (`matchedTotal` on `error.data`) and, when the page is partial, says so and points at narrowing the query. Reporting the page length as the match count would understate the choice and hide that the wanted record may not be listed at all.

**A skipped lookup says it was skipped.** `include_works` on `crossref_search_journals` addresses the works list by ISSN and by nothing else, so a matched journal with no registered ISSN — real, and reachable by title query — has no works list to request. Returning the journal record alone is indistinguishable from a journal with no works, so that path emits a `notice` naming the cause and stating that no lookup ran. It names no retry identifier because there is none; it points at `crossref_search_works` with `queryContainerTitle` instead. The analogous branch in `crossref_search_funders` (a matched funder with no `id`) stays silent: the registry ID is the Funder Registry's primary key and is present on every record either route returns, so the branch is unreachable and a notice there would describe a state that does not occur.

**A superseded funder is reported, never followed.** The Funder Registry deprecates entries: the old record carries `replaced-by` with the current registry ID, the current one carries `replaces`. Both fields are present on every funder record, on the single lookup and the name search alike, as arrays that are empty when the relationship does not apply — so they are projected only when non-empty rather than emitted as a meaningless `replacedBy: []` on every ordinary funder. A deprecated entry answers to the same name and abbreviation as its successor while holding only the works registered against the old ID, so resolving to one returns an undercount as the answer; the response carries a `notice` naming the successor, and `format()` renders the relationship, so the fact reaches a content-only client. Auto-following the replacement would resolve to a funder the caller did not ask for, which is worse than the undercount — the caller is told and decides.

### Text normalization

Every human-readable value projected out of a Crossref record passes through one baseline: HTML entities decoded, whitespace collapsed to single spaces, trimmed (`normalizeText`). Identifiers and machine-format values — DOIs, URIs, ISSNs, prefixes, dates, work types, coverage categories — are returned byte-exact and never go through it.

The fields publishers deposit as JATS XML — work `title`, `subtitle`/`short-title`, `container-title`, and `abstract` — get inline markup stripped first (`normalizeMarkupText`). Order is load-bearing: tags come out before entities are decoded, so a deposited `&lt;i&gt;` survives as literal text instead of decoding into a tag the strip pass would then eat. Whitespace collapse runs on *any* run of whitespace rather than runs of two or more — a lone `\n` in a deposited title splits the Markdown heading in `content[]` on its own, and the indented continuation renders as a code block.

Stripping is tag-aware. A tag is a word boundary and is replaced by a space — that separator is what keeps adjacent JATS paragraphs in an abstract from running together. `<sub>` and `<sup>` are the exception and are replaced by nothing: their content continues the token around them, so `CO<sub>2</sub>` is one formula and a space there splits it. The exception is narrow enough to leave the paragraph separator intact, since `<jats:p>` is not a subscript — the two rules do not trade against each other. Sizing it: 0.48% of works corpus-wide carry `<sub>`/`<sup>` in the title, rising to 16–31% in physical-chemistry journals; across 1,009 sampled sub/sup titles the tight join changed 950 and glued a following word onto a formula in 15 (`ND<sub>3</sub>with Ar`, deposited with no space), which is a cosmetic loss against a chemical formula rendered correctly.

Reference entries stay on the baseline pass deliberately. Angle brackets are rare in `unstructured` / `article-title` / `journal-title` and ambiguous when they appear: a 153,827-field sample carried them on 0.21% of entries, split between real markup (`<i>`, `<b>`, embedded MathML) and text a strip pass would delete — a bracketed URL, a Miller index (`<100>`), a DOI fragment (`<131::AID-QUA4>`), an acronym (`<IR>`). Deleting a cited URL is a worse failure than leaving an `<i>` in place, so the ambiguity is resolved toward keeping the deposited string.

### `format()` Notes

Both surfaces (`structuredContent` from `output` and `content[]` from `format()`) must carry the same data. `format()` is not a count/title stub — it must render title, authors, DOI, abstract (or "not deposited"), reference count, license, and the reference list with resolved DOIs where available.

**Parity rule:** `format()` never truncates, caps, slices, or rounds away anything present in `output`. It renders every element of every array and the full text of every string it surfaces. Truncation applied only in `format()` produces client-specific data loss — content-only clients silently lose data that structured-content clients receive, with no retrieval path.

When a payload genuinely needs bounding, bound it **symmetrically in the handler** so both paths carry the identical page, and expose the retrieval input that reaches the rest. `crossref_get_references` is the worked example: `offset`/`limit` inputs page the list, `referenceCount` reports the full deposited total, and `nextOffset` enrichment hands back the input for the following page. `crossref_search_journals` and `crossref_search_funders` follow the same shape twice over, once per list they return. Numeric rendering follows the same rule — precision scales to magnitude so a small nonzero value never renders as zero (see `formatCoverage` in `crossref_get_member`).

Enrichment is a parity surface, not a structured-content-only one: the framework merges enrichment into `structuredContent` **and** renders it as a trailer block appended to `content[]`. Page metadata therefore lives in `enrichment` rather than being duplicated into `output` — one declaration, both paths. The corollary is that a field the enrichment block does not declare is stripped from `structuredContent` and omitted from the trailer, silently, no matter what the handler computed or `format()` renders. Tests assert new fields by parsing through `output.extend(enrichment)` (or by driving the definition with `runToolContract`), so deleting a *declaration* fails a test rather than quietly shrinking the wire payload.

### Resources

No resources defined. All data is accessible through the tool surface; Crossref records are live-fetched and not suitable as stable injectable URIs.

### Prompts

No prompts defined. This is a data retrieval server; recurring patterns are covered by tool descriptions.

---

## Overview

crossref-mcp-server wraps the Crossref REST API to expose canonical scholarly metadata for ~155 million registered works (journal articles, books, chapters, conference papers, preprints, datasets, components). It is the authoritative source for DOI-registered metadata — titles, authors, affiliations, abstracts (where deposited), licenses, full-text links, funder acknowledgements, and outgoing reference lists. It reports an incoming citation count (`is-referenced-by-count`) but not the citing works; citation graphs belong to OpenAlex.

**Pairs with:** pubmed-mcp-server (biomedical-specific abstracts/MeSH), openalex-mcp-server (analytics, citation graphs, topics, concepts), arxiv-mcp-server (preprints — their DOIs resolve through Crossref), biorxiv-mcp-server (preprints — same).

---

## Requirements

- Read-only. No writes to Crossref.
- All requests include a polite-pool `User-Agent` header (`crossref-mcp-server/0.1.0 (mailto:<CROSSREF_MAILTO>)`) when `CROSSREF_MAILTO` is set. The env var is optional — without it the server starts but uses the anonymous pool with stricter rate limits. No token is required — polite-pool access is granted solely via the mailto User-Agent.
- Offset paging on `/works` is capped at ~10K results per query. Results beyond that require cursor-based paging (`cursor=*` to start, then pass the `next-cursor` value from each response). Mixing `cursor` and `offset` is not supported. `/works` never terminates a walk by withholding the token, and the token itself carries no progress signal: after the first response the same 1512-character value comes back on every page of the walk, item-bearing and empty alike, so comparing one page's token to the next says nothing about where the walk is. Past the end the route answers `items: []` and hands that same token back indefinitely. The empty page is the only end-of-list signal upstream provides — verified on `/works`, `/journals/{issn}/works`, and `/funders/{id}/works`.
- The offset ceiling is per-route, not global. `/journals` and `/funders` name search accept `offset + rows` up to 100,000; `/journals/{issn}/works` and `/funders/{id}/works` cap at 10,000. Past either, Crossref answers HTTP 400 `integer-not-valid` naming the ceiling for the supplied `rows`. Both works sub-resources accept `cursor` instead, which has no ceiling; the name-search routes do not.
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
| `CrossrefService` | Crossref REST API (`https://api.crossref.org/`) | All seven tools |

### CrossrefService design

- Singleton, initialized in `setup()`, accessed via `getCrossrefService()`.
- Injects polite-pool `User-Agent` on every request from config.
- Raw `fetch` for all HTTP, not the framework's `fetchWithTimeout` — the helper throws on non-2xx and hands back only a truncated body string, which would cost the 400 branch its parse of Crossref's `validation-failure` body and turn every 404 into a logged error rather than the `null` the handlers convert into a typed reason. The two mechanisms worth having from it are replicated locally instead: an `AbortController` aborted with a `TimeoutError` DOMException, matched by identity, and a `catch` around the transport that reports the network failure's `.cause`.
- Every failure leaves `attempt()` as an `McpError` with a classified code. That is what makes retry behavior correct rather than incidental: `withRetry`'s default predicate treats *any* non-`McpError` throw as transient, so an unwrapped `SyntaxError` or `TypeError` is both retried to exhaustion and then classified from its constructor name.
- `withRetry`: 3 retries on top of the first attempt, 1s base delay (rate-limit recovery), exponential backoff, upstream `Retry-After` honored over the exponential value. The stock predicate is kept — no custom `isTransient`. Two throw sites opt out with `retryable: false`. Bytes that arrive complete and then fail to parse throw `malformed_response`, because an identical GET re-serializes the same corrupt body; an HTML error page and an empty body throw `upstream_unavailable` instead, since the first is a maintenance interstitial and the second a truncated or dropped response, and both can clear on a retry. And a client-side deadline expiry throws `request_timeout` non-retryably, because it is the one transient failure whose cost is set by this server's clock rather than by how fast the upstream answers: four attempts at the default `CROSSREF_TIMEOUT_MS` is ~40s of deadline plus ~7s of backoff before the caller hears anything, which can exceed an MCP client's own request budget and leave the recovery hint unread. The same reason raised from a 408/504 keeps the full budget — those arrive at upstream speed.
- Field selection: `select=` works on `/works` (search) only — not on `/works/{doi}`. For `crossref_get_references`, fetch the full record from `/works/{doi}` and extract the `reference` field from the response body rather than using a select shortcut.
- Pagination: `offset` is honored on `/works`, on both name-search routes, and on both works sub-resources; the ceiling differs by route (`NAME_SEARCH_OFFSET_CAP` = 100,000, `WORKS_OFFSET_CAP` = 10,000, `/works` ~10K). `cursor` is accepted on `/works` and on both works sub-resources and has no ceiling: pass `cursor=*` on the first request, then the `next-cursor` token from each response. Cursor and offset cannot be used together — one `setSubResourcePage` helper writes whichever applies, cursor first, and an offset of 0 is left off the query string entirely. Throw when offset is requested past the ceiling and cursor was not supplied. `nextPageOffset()` classifies a page's continuation as `next` / `end` / `ceiling` rather than returning an offset-or-nothing: `end` and `ceiling` both withhold an offset but mean different things to a caller, and collapsing them into one absent field is what makes a truncated list read as a complete one. A cursor page has no position, so it carries neither a continuation offset nor a ceiling; its token is withheld on an empty page, since Crossref keeps minting one past the end of a list and a caller reading "absent means exhausted" on the offset path must be able to read it the same way here.
- List envelopes: `searchJournals` / `searchFunders` return `{ totalResults, items }` rather than a bare array — the `total-results` field is what tells a caller more pages exist. The ISSN and funder-DOI single-record paths report a total of 1 and ignore `offset`, since neither route pages.
- Status mapping: 429, 408/504, and 5xx map onto the upstream contract; 400 and 404 are left with the treatment the handlers depend on. The 5xx branch also lifts 500/501 out of the framework's default `InternalError`, which would report a Crossref outage as a bug in this server and would not be retried.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `CROSSREF_MAILTO` | No | Email address embedded in the polite-pool `User-Agent` header. Optional — server starts without it but logs a warning and uses the anonymous pool with stricter rate limits. |
| `CROSSREF_BASE_URL` | No | Override API base URL. Defaults to `https://api.crossref.org`. Useful for testing against a local proxy. |
| `CROSSREF_TIMEOUT_MS` | No | Per-request timeout in milliseconds. Default: `10000`. Also the worst-case wait a caller sees on an unresponsive upstream: a deadline expiry is not retried, so the call fails one timeout window in. |

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
| Member | `GET /members/{id}` | `crossref_get_member` |
| Prefix | `GET /prefixes/{prefix}` | `crossref_get_prefix` |
| Type | — | Not exposed (enum used as a filter value; no dedicated tool warranted) |

---

## Workflow Analysis

**`crossref_search_journals` with `include_works: true`** (2 upstream calls):

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /journals?query=…` or `GET /journals/{issn}` | Resolve journal, return metadata |
| 2 | `GET /journals/{issn}/works` | Fetch a page of recent works for the matched journal |

Both calls run sequentially (step 2 depends on ISSN from step 1). Step 2 is only made when `include_works: true`, and only when step 1 matched exactly one journal upstream — a title query matching several throws `ambiguous_journal` instead, however many of them fit on the requested page. Each step carries its own offset (`offset`, `works_offset`) against its own route ceiling.

**`crossref_search_funders` with `include_works: true`** (2 upstream calls):

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /funders?query=…` or `GET /funders/{id}` | Resolve funder, return metadata |
| 2 | `GET /funders/{id}/works` | Fetch a page of funded works for the matched funder |

Same sequential pattern, same guards: step 2 only on `include_works: true`, only when step 1 matched exactly one funder upstream (otherwise `ambiguous_funder`), and each step pages independently.

Note that `/funders/{id}/works` and a `filter=funder:10.13039/{id}` search on `/works` are close but not identical sets — the sub-resource rolls in the funder's registry descendants, so its `total-results` runs higher. That is why deep paging is threaded through the sub-resource as `works_cursor` rather than delegated to `crossref_search_works`: the filter would reach past the ceiling while quietly answering a narrower question.

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
- **Member and Type endpoints — expose as tools?** → No. Members (publishers) are administrative detail with low agent-workflow value; Type is an enum used as a filter input, not a queryable entity. *(Member portion superseded 2026-07-13 — `crossref_get_member` was added; see Reversals. Type still stands.)*
- **Resources — add any?** → No. Crossref records are live-fetched; there are no addressable stable URIs the server owns. Tool surface is self-sufficient.
- **Journal/funder paging — extra inputs on the existing tools, or dedicated works tools?** → Extra inputs (`offset`, `works_offset`) on the existing tools. Rationale: each tool already returns both lists in one response, so splitting the works retrieval into its own tool would widen the surface without removing a call, and would strand the existing `include_works` shape. Two independent offsets on one tool cost less than four tools.
- **Cursor paging for the journal/funder works sub-resources?** → Yes, as `works_cursor` / `nextWorksCursor` on both tools. Offset paging reaches under 2% of a large corpus (Nature's 446,507 works, NSF's 559,023), and the alternative — `crossref_search_works` with an `issn:` / `funder:` filter — costs a tool switch mid-pagination and, on funders, answers a narrower question, since the sub-resource rolls in registry descendants and the filter does not. The works list stays a secondary surface on a tool whose primary result is the name search, which is why the cursor is another input on the existing tool rather than a tool of its own. *(Deferred at 0.3.0; the deferral's own rationale is what reversed it — see Reversals.)*
- **Cursor and offset on the works sub-resources — precedence rule or refusal?** → Refusal (`works_cursor_offset_conflict`), matching `cursor_offset_conflict` on `crossref_search_works`. Crossref rejects the pair outright, and a silent precedence would page a caller through a list they did not ask for while their other input sat unused. The guard keys on `works_offset > 0`, not on the field's presence: the input carries a schema default of 0 that no handler can tell from an omitted field, and 0 is the start of the list and is never transmitted, so every combination in which an offset would actually be spent trips the guard and none that would be silently dropped escapes it.
- **What ends a cursor walk?** → An empty page, not an absent token, on every cursor surface this server exposes. Crossref keeps returning a `next-cursor` past the end of a list — verified on `/works`, `/journals/{issn}/works`, and `/funders/{id}/works` — so relaying it verbatim loops a caller forever. `nextWorksCursor` and `nextCursor` are alike withheld once a page comes back empty, which keeps "no continuation field means the list is exhausted" true across both paging modes and all three tools. The guard keys on the page's item count, the quantity that says the walk is over; `totalResults` describes the query and stays at its full value on an exhausted page, so it cannot serve.
- **Does an exhausted walk need more than an absent token?** → Yes on `crossref_search_works`, no on the two sub-resource works lists, and the asymmetry is a property of the payloads rather than of the paging. `works` is the entire result of a works search, so an empty page with nothing said about it renders as blank text for a client reading only `content[]` — absence of a field it never sees is not a signal it can act on. The sub-resource tools always still render the journal or funder record that page was about. So the works search carries a `notice` on every empty page, naming which of the three causes applies: a query nothing matched, an offset past the end of a list that did match, or a completed cursor walk. The guard keys on the page's item count, which is what makes a page empty; `totalResults` only separates the causes, and gating on it alone left the two commonest empty pages unexplained on both result surfaces.
- **Retry policy for a request timeout?** → Non-retryable at the deadline-expiry throw site; the contract entry stays retryable for 408/504. A timeout is the one transient class whose cost is bounded by this server's own deadline rather than by how fast the upstream answers, so every retry costs the maximum instead of the typical: four attempts at the default `CROSSREF_TIMEOUT_MS` is ~40s of deadline plus ~7s of backoff, which can outrun an MCP client's own request budget and leave the recovery hint unread. Deriving `maxRetries` from `CROSSREF_TIMEOUT_MS` was the alternative and was rejected — `withRetry` takes one budget for every error class, so tying it to the timeout would also cut the retries that let a 429 or a 5xx clear. The split belongs at the throw site because that is where the two costs are distinguishable, and `retryable: false` is the mechanism the stock predicate already honors, so no custom `isTransient` is needed.
- **Continuation offsets past the route ceiling — hand them out and let Crossref reject, or withhold?** → Withhold, but say so. A `nextOffset` a client cannot spend reads as "more is retrievable this way" and costs a round trip to disprove. Withholding it silently is the opposite failure: absence of the field otherwise means "the list is exhausted," so a ceiling-truncated page reads as complete, and because the offset is never handed out the caller never trips `offset_too_large` and never reads the recovery that names the escape hatch. The ceiling page therefore carries a `notice` stating the cap, the true total, and the route that reaches the rest.
- **Ambiguous `include_works` on funders — reject, or return the works with a source label?** → Reject, matching the journals guard. Rationale: consistency between the two tools matters more than the extra round trip, and a label only helps clients that read `structuredContent` — a content-only client would still see an unattributed works list. Refusing puts the identifier in the caller's hands either way.
- **Ambiguity measured against the returned page, or the upstream match count?** → The match count. Rationale: a page-length test is defeated by `rows: 1` and by any `offset` landing on the tail of a list — the response then holds exactly one record and the guard passes, restoring the silent pick it exists to prevent. The match count is the only measure of whether the caller actually chose the record whose works come back.
- **Recovery hints for the shared service's throws — per-tool contract entries or literals at the throw site?** → Both, from one table. `ctx.recoveryFor` is unusable from inside `CrossrefService`: it resolves against the *calling* tool's declared reasons and returns an empty object for any tool that has not declared the one being raised — no hint on the wire, no error, nothing to notice. So the service builds the hint itself. The contract entries are still declared on all seven tools, because a contract that omits the failures a tool can actually raise is wrong regardless of who populates the wire, and `errors[]` is compile-time and linter metadata rather than a `tools/list` payload, so the duplication costs a caller nothing. Drift between the two is prevented by construction: `upstream-errors.ts` holds one entry per reason, the tools spread it into `errors[]`, and the service reads `recovery` off the same object at the throw site.
- **Adopt the framework's `fetchWithTimeout` for the transport?** → No. It would fix timeout classification by construction, but it throws on non-2xx and returns only a 500-byte body string, so the 400 branch could no longer parse Crossref's `validation-failure` body into a filter-key hint, and every 404 — a routine outcome the handlers turn into `doi_not_found` — would be logged at error severity. Its two load-bearing mechanisms are cheap to replicate and were: identity-matched `TimeoutError` aborts and a transport `catch` that unwraps `.cause`. Revisit if the helper ever hands the `Response` back to the caller.
- **A custom `isTransient` predicate for `withRetry`?** → No. The retry waste was never the predicate's fault: it treats a non-`McpError` throw as transient, and every throw that reached it was unclassified. Classifying at the throw site fixes retry cost and the surfaced error code together, and one deterministic case that still lands on a transient-looking code (`malformed_response`) opts out through the contract's `retryable: false`, which the stock predicate already honors. A custom predicate would re-sort the same unclassified exceptions by shape, one layer too late.

### Corrections from API verification (v0.2 → v0.3)

- **`offset` is honored on all four journal/funder routes.** Verified by row identity, not status code — `/journals`, `/funders`, `/journals/{issn}/works`, and `/funders/{id}/works` each return different records at `offset=0` and `offset=2` with a stable `total-results`. A route that ignored `offset` would answer 200 with the unfiltered first page, so status alone proves nothing here.
- **The offset ceiling is not uniform.** The name-search routes accept `offset + rows` up to 100,000; the works sub-resources cap at 10,000 and say so in the rejection body ("Use the cursor parameter to page further into result sets"). An earlier single ~10K figure covered `/works` only.
- **The works sub-resources do support `cursor`.** `GET /journals/{issn}/works?cursor=*` and `GET /funders/{id}/works?cursor=*` each return a `next-cursor` token, so the 10,000 ceiling bounds the `offset` input alone and is not an upstream limit on how far either list can be read.
- **`GET /funders/{id}` accepts three identifier forms** — bare registry ID, percent-encoded full DOI, and full DOI with a literal slash — all returning the same record. The `funder_doi` validator had required the `10.13039/` stem, rejecting the bare form its own description documented before any request was made.

### Options declined

- **Multi-hop `crossref_get_references` with a `depth` parameter** → Declined. Exponential upstream call growth per hop, unbounded latency, and rate-limit risk disproportionate to the use case. Agent chaining is the right model.
- **`crossref_get_member` tool** → Declined. Publisher administrative metadata (member records) has minimal agent utility and would widen the surface with low-value data. *(Superseded 2026-07-13 — see Reversals.)*
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

### Reversals

- **`works_cursor` threaded through both works sub-resources (2026-08-06).** Reverses "Cursor paging for the journal/funder works sub-resources? → Not in this release" (Answered questions). The deferral rested on `crossref_search_works` with an `issn:` / `funder:` filter being an adequate substitute; it is not. On funders the two sets differ by design — `/funders/{id}/works` reported 559,023 works for NSF against 454,467 through the `funder:` filter, because the sub-resource includes the funder's registry descendants — so redirecting a caller there past the ceiling answered a narrower question without saying so. The reach argument compounded it: offset paging covers under 2% of either Nature's or NSF's works list, which makes the ceiling the normal case for any large corpus rather than an edge. `crossref_search_works` remains valid for callers who want the filter's semantics; it is no longer the only route past 10,000.
- **`crossref_get_member` and `crossref_get_prefix` added (2026-07-13).** Reverses the earlier "Member and Type endpoints — expose as tools? → No" (Answered questions) and "`crossref_get_member` tool → Declined" (Options declined). The prior calls judged member records as low-value administrative detail; that under-weighted publisher identification as an agent workflow — "who publishes DOIs under prefix 10.1038?" and "how completely does this publisher deposit references/abstracts/ORCIDs?" The member record carries genuine signal (owned prefixes, DOI counts, per-work-type breakdown, per-category deposit coverage), and `crossref_get_prefix` resolves a DOI prefix to its owning member ID for a clean two-step lookup. The prefix response is honestly thin (owner name + member link only), so its output mirrors exactly that. Type-listing stays declined — a closed enum is better as a `crossref_search_works` filter value than a tool. Event Data (`crossref_search_events`, the third tool proposed alongside these) was dropped: the Event Data public API was permanently sunset on 2026-04-23, so there is no live upstream to wrap.
