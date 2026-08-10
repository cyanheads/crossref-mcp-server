<div align="center">
  <h1>@cyanheads/crossref-mcp-server</h1>
  <p><b>Resolve DOIs, search ~155M scholarly works, fetch references, and look up publishers via the Crossref REST API. STDIO or Streamable HTTP.</b>
  <div>7 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.8-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/crossref-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.30.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/crossref-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/crossref-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.14-blueviolet.svg?style=flat-square)](https://bun.sh/)

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/crossref-mcp-server/releases/latest/download/crossref-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=crossref-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvY3Jvc3NyZWYtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22crossref-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads/crossref-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Tools

Seven tools for working with Crossref data — DOI resolution, full-text search across all scholarly works, outgoing reference lists, and journal, funder, and publisher lookup:

| Tool | Description |
|:-----|:------------|
| `crossref_get_work` | Resolve a DOI to its full Crossref metadata record: title, authors, affiliations, abstract (when deposited), journal, publication date, type, license, full-text links, funder acknowledgements, and outgoing reference count. The author list pages by `offset`/`limit`. |
| `crossref_search_works` | Search the Crossref works index by free text and/or structured filters. Supports sort, field selection, a per-work author cap, and cursor-based deep paging. |
| `crossref_get_references` | Return the outgoing reference list for a DOI — the works cited by this paper, with deposited citation strings and resolved DOIs where available |
| `crossref_search_journals` | Find Crossref journal records by ISSN or title query; optionally retrieve a page of the journal's most recent works by publication date. Both lists page by offset. |
| `crossref_search_funders` | Find funders registered in the Crossref Funder Registry by name, bare registry ID, or funder DOI; optionally retrieve a page of funded works. Both lists page by offset. |
| `crossref_get_member` | Resolve a Crossref member ID to its publisher record — name, owned DOI prefixes, DOI counts, per-work-type breakdown, and per-category metadata deposit coverage |
| `crossref_get_prefix` | Resolve a DOI prefix (e.g. `10.1038`) to its owning publisher — name and member ID, chaining into `crossref_get_member` |

### `crossref_get_work`

Resolve a DOI to its canonical Crossref record.

- DOI validated against `10.NNNN/suffix` regex before the upstream call
- Returns title, authors with affiliations, abstract (when deposited), container/journal, publication date, work type, ISSN, license URLs, full-text link URLs, and funder acknowledgements
- The author list is paged with `offset` and `limit` (default 25, max 500). `authorCount` is the full deposited total; when authors remain, the response carries a `nextOffset` to pass back as `offset`. Ordinary records fit in a single page — large-collaboration papers deposit thousands of authors, enough to fill a client's context from one record. Only the author list is paged; every other field comes back in full on every page.
- A funder or an affiliation the publisher asserted through the ROR registry rather than by name carries that identifier as `ror`, and no `name`. The entry still names an organization instead of coming back as an award number with nothing attached to it.
- A date component Crossref records as unknown — it deposits `null` in place of the number — is omitted rather than reported, so a record with no registered year comes back with no publication date.
- Outgoing references are reported as a count; the entries themselves come from `crossref_get_references`
- Incoming citation count (`is-referenced-by-count`) is included; citing works are not — Crossref does not expose that data. Use OpenAlex for citation graphs.

---

### `crossref_search_works`

Search across ~155M Crossref-registered works.

- Free-text `query` plus a structured `filter` object using Crossref's hyphen-separated key syntax: `from-pub-date`, `until-pub-date`, `type`, `funder`, `issn`, `member`, `has-abstract`, `has-references`, `has-full-text`, `directory` (use `DOAJ` to restrict to open-access content)
- Field-specific query parameters scope matching beyond the generic `query`: `queryTitle`, `queryAuthor`, `queryContainerTitle` (journal/book name), and `queryBibliographic` (whole-citation match to resolve a known reference to its DOI) — all combine with each other and with `query`
- Sort by `relevance`, `is-referenced-by-count`, `published`, `deposited`, or `score`
- `fields` parameter narrows response payload — useful for large result sets. Names are case-sensitive; `DOI` is always returned whether or not it is listed, so every result stays resolvable by `crossref_get_work`.
- Each work returns at most `authorLimit` authors (default 25, max 500), with `authorCount` reporting that work's full deposited total. A single page of large-collaboration papers can carry tens of thousands of author entries; pass a cut work's DOI to `crossref_get_work` to page its whole author list, or raise `authorLimit` to widen the cap here.
- Offset paging up to ~10K results; deep paging requires `cursor=*` on the first call, then pass the returned `nextCursor` token. Cursor and offset cannot be combined.
- A cursor walk ends on the page that omits `nextCursor`. Crossref keeps minting a token past the end of a list, so the token is withheld on an empty page rather than relayed — the rule the `works_cursor` walks below follow too. Here that page also carries a `notice` saying the walk is complete, because `works` is this tool's whole payload and an empty page nothing is said about renders as blank text.

---

### `crossref_get_references`

Fetch the outgoing reference list for a DOI.

- Each reference includes its deposited citation string and, where Crossref has resolved it, a DOI for follow-up lookup
- Citation strings come back with markup removed — inline emphasis (`<i>`, `<em>`, `<small>`, `<span>`), scripts (`<sub>`, `<sup>`, `<inf>`), block boundaries (`<p>`, `<br>`, `<refersplit />`), MathML and TeX formula wrappers, and a whole JATS `<mixed-citation>` deposited into a free-text field. A bracket comes out only when it is a well-formed tag whose element name is on a closed list, so an angle-bracket span that is not one — a cited URL, a Miller index, a DOI fragment, a bracketed phrase — is returned exactly as deposited. A link (`<a>`, `<ext-link>`, `<uri>`) is decided against its own text: its tags come out where the text already carries what the `href` holds, and stay where the `href` addresses something the text does not name.
- Paged with `offset` and `limit` (default 100, max 500). `referenceCount` is the full deposited total; when more remain, the response carries a `nextOffset` to pass back as `offset`. Most works fit in a single page — bibliography records can carry tens of thousands of references.
- Coverage varies by publisher — pre-2000 literature and non-participating publishers may have no reference list
- Single-hop only; agents that need N-hop traversal chain calls explicitly

---

### `crossref_search_journals`

Find journal records by ISSN or title.

- `include_works: true` also returns a page of the journal's most recent works by publication date
- Returns journal title, publisher, ISSN-L, subject areas, and total DOI count
- Title-query results page with `offset`; `journalsTotal` reports the full match count and `nextOffset` carries the input for the following page. The journal works list pages separately with `works_offset` and `nextWorksOffset`.
- The two lists have different ceilings: title search allows `offset + rows` up to 100,000, the works list only 10,000. A page that stops at either ceiling carries a `notice` saying so — a missing continuation offset would otherwise read as the end of the list.
- The journal works list also pages by cursor, which has no ceiling: pass `works_cursor="*"` and chain the `nextWorksCursor` token from each response to read the whole list. A cursor walk starts at the newest work and cannot resume from an offset, and the two cannot be combined — `works_cursor` with a nonzero `works_offset` returns `works_cursor_offset_conflict`. Each token runs about 1500 characters on both result surfaces, a cost per page rather than per record, so a long walk is cheaper at a high `rows`.
- `include_works` needs an unambiguous journal. A title query matching more than one — measured by the upstream match count, not by how many fit on the requested page — returns `ambiguous_journal`, naming the page's candidates and their ISSNs in the message and in `candidates` on the error data, alongside the full match count. Pass one back as `issn`, or narrow the query when the journal you want is not among them.
- The works list is addressable by ISSN alone, so a matched journal with none registered has no works list to request. `include_works` is then skipped and the response carries a `notice` saying so — an absent `recentWorks` would otherwise read as a journal with no works, and `totalDois` is the journal's own DOI count rather than an answer about the lookup. There is no alternative identifier to retry with; use `crossref_search_works` with `queryContainerTitle` instead.

---

### `crossref_search_funders`

Find funders in the Crossref Funder Registry.

- Accepts a name query, a bare registry ID (`100000001`), or a full funder DOI (`10.13039/100000001`, optionally behind a `doi:` or `https://doi.org/` prefix)
- `include_works: true` also returns a page of works funded by the matched funder
- Returns funder name, registry ID, country, and alternate names
- Name-query results page with `offset`; `fundersTotal` reports the full match count and `nextOffset` carries the input for the following page. The funded works list pages separately with `works_offset` and `nextWorksOffset`.
- The two lists have different ceilings: name search allows `offset + rows` up to 100,000, the works list only 10,000. A page that stops at either ceiling carries a `notice` saying so — a missing continuation offset would otherwise read as the end of the list.
- The funded works list also pages by cursor, which has no ceiling: pass `works_cursor="*"` and chain the `nextWorksCursor` token from each response to read the whole list. A cursor walk starts at the newest work and cannot resume from an offset, and the two cannot be combined — `works_cursor` with a nonzero `works_offset` returns `works_cursor_offset_conflict`. Each token runs about 1500 characters on both result surfaces, a cost per page rather than per record, so a long walk is cheaper at a high `rows`. This list counts works funded by the funder's registry descendants, which a `crossref_search_works` filter on `{"funder": "10.13039/<id>"}` does not.
- `include_works` needs an unambiguous funder. A name query matching more than one — measured by the upstream match count, not by how many fit on the requested page — returns `ambiguous_funder` rather than resolving one silently, naming the page's candidates and their registry IDs in the message and in `candidates` on the error data, alongside the full match count. Pass one back as `funder_doi`, or narrow the query when the funder you want is not among them.
- The Funder Registry supersedes entries, and a deprecated one answers to the same name and abbreviation as its successor while carrying only the works registered against the old ID — so resolving to it hands back an undercount as the answer. A superseded record carries `replacedBy` with the superseding registry ID (and the current record carries `replaces`), and the response carries a `notice` naming the successor on both the `funder_doi` and `query` paths. The replacement is never followed automatically: re-run with `funder_doi` set to that ID to get the current entry.

---

### `crossref_get_member`

Resolve a Crossref member ID to its publisher/organization record.

- Members are the organizations that register DOIs — this answers "what does this publisher publish, and how completely do they deposit metadata?"
- Returns primary name, alternate imprint names, owned DOI prefixes, DOI counts (total/current/backfile), a per-work-type breakdown, and per-category metadata deposit coverage (references, abstracts, ORCIDs, funders, licenses, and more) as current/backfile fractions
- Pair with `crossref_get_prefix` to resolve a DOI prefix to the member ID first

---

### `crossref_get_prefix`

Resolve a DOI prefix to its owning publisher.

- Accepts the registrant prefix of a DOI (e.g. `10.1038`, no `/suffix`)
- Returns the publisher name and numeric member ID — the ID chains directly into `crossref_get_member` for the full record
- The Crossref prefix record is thin by design (owner name and member link only); richer publisher data lives on the member record

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling across all tools
- Pluggable auth (`none`, `jwt`, `oauth`)
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

Crossref-specific:

- Polite-pool `User-Agent` header injected on every request — priority access granted via `CROSSREF_MAILTO` email address, no API token required
- Retry with exponential backoff on 429 (honoring `Retry-After`), 5xx, HTTP 408/504, and network failures. Two failures are not retried: a malformed response body, which an identical request re-serializes, and a request that hits `CROSSREF_TIMEOUT_MS`, where every attempt costs the full deadline
- Upstream failures arrive classified and with recovery guidance on both result surfaces: rate limit, service unavailable, timeout, and malformed response each say what to do next in `content[]` as well as in `structuredContent`
- Cursor-based deep paging on the works search and on both works sub-resources, for result sets beyond the offset cap
- Filter key validation: Crossref uses hyphens (`has-abstract`, `has-references`, `from-pub-date`); the server enforces correct syntax and surfaces API validation errors with actionable recovery hints
- Text normalization on every human-readable value returned: character references decoded against the full HTML5 named set (2,125 names) plus the decimal and hex forms, whitespace collapsed to single spaces. Decoding is a single pass, so escaped text stays escaped — `&amp;lt;` reads as the literal `&lt;`, never as `<` — and a reference has to end in a semicolon, so the bare `&` in `R&D` or in a URL's query string comes back as deposited. The fields publishers deposit as JATS XML — work titles, subtitles, container titles, and abstracts — and the citation strings in a reference list additionally have markup stripped, so an italicized species name reaches `content[]` as text instead of an `<i>` tag and a newline that splits the Markdown heading. Both run one rule: a bracket comes out only when it is a well-formed tag — one inside a MathML or structured-citation region, or one the element-name classification recognizes — so a cited URL, a Miller index, a DOI fragment, and a bracketed phrase come back as deposited. A JATS `<alternatives>` wrapper holds one object encoded several ways, and its first text-bearing child is the one returned, so a formula deposited as both TeX and MathML renders once instead of twice, and it stands as its own token in the sentence the way a MathML formula does, whichever encoding it kept. A link (`<a>`, `<ext-link>`, `<uri>`) is the one element decided against its own text rather than by name, because that is where the address it carries may or may not already be: the tags come out where the text holds what the `href` holds — verbatim or less its scheme — and stay where the `href` addresses something the text does not name, so a trial registration deposited as both text and `href` reaches the reader as plain text, while a link showing only a site's homepage over an `href` that points at one record keeps its tag rather than losing the record. Removing a tag leaves the separator its class calls for: scripts and formula wrappers leave none, because their content continues the token around them (`CO<sub>2</sub>` reads `CO2`, not `CO 2`, and a MathML formula reads as one expression); inline emphasis leaves a space only where the text would otherwise run together, between two word characters or where a sentence ends and the next word begins; block boundaries always leave one. The two surfaces differ in one thing — an element name neither recognizes is structure in a JATS field and is removed, and is presumed content in a citation string and stays. A bracket the rule keeps then has to survive the client's Markdown renderer, which would otherwise consume a kept link down to the text it wraps and drop the address behind it, resolve an escaped character reference, and pair a deposited `*` with the emphasis `format()` writes around a journal title — so every normalized value is escaped on its way into `content[]`, and only where a reader would take a character for markup: `R&D` and `[18F]FDG` are untouched while `&lt;` and `<ext-link …>` are not. A marker that opens a Markdown block — the `19.` an abstract begins on, a leading `- ` — is escaped only on the one line that renders a deposited value at column zero, since anywhere else it is inert. Identifiers and machine-format values (DOIs, URLs, ISSNs, prefixes, dates, work types) are returned byte-exact on both surfaces, since they are what a reader copies

## Getting started

Add the following to your MCP client configuration file. `CROSSREF_MAILTO` is optional but recommended — without it the server uses Crossref's anonymous pool with stricter rate limits.

```json
{
  "mcpServers": {
    "crossref-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/crossref-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "CROSSREF_MAILTO": "your-email@example.com"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "crossref-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/crossref-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "CROSSREF_MAILTO": "your-email@example.com"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "crossref-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-e", "CROSSREF_MAILTO=your-email@example.com",
        "ghcr.io/cyanheads/crossref-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 CROSSREF_MAILTO=your-email@example.com bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3.14](https://bun.sh/) or higher (or Node.js v24+).
- An email address for `CROSSREF_MAILTO` is optional but recommended — Crossref's polite pool grants priority access to clients that identify themselves. No account or token is required.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/crossref-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd crossref-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and optionally set CROSSREF_MAILTO for polite-pool access
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`.

| Variable | Description | Default |
|:---------|:------------|:--------|
| `CROSSREF_MAILTO` | Email address embedded in the polite-pool `User-Agent` header. Optional — server starts without it but logs a warning and uses the anonymous pool with stricter rate limits. | — |
| `CROSSREF_BASE_URL` | Crossref API base URL. Override for testing against a local proxy. | `https://api.crossref.org` |
| `CROSSREF_TIMEOUT_MS` | Per-request timeout in milliseconds. Also the worst-case wait against an unresponsive upstream — a request that hits the deadline is not retried. | `10000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and inits services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Seven tools for Crossref data access. |
| `src/services/crossref` | CrossrefService — HTTP client, polite-pool header, retry, pagination helpers. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools via the barrel in `src/mcp-server/tools/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields (abstracts, reference lists, and affiliations are frequently absent in Crossref records)

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
