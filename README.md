<div align="center">
  <h1>@cyanheads/crossref-mcp-server</h1>
  <p><b>Resolve DOIs, search ~155M scholarly works, fetch references, and look up publishers via the Crossref REST API. STDIO or Streamable HTTP.</b>
  <div>7 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.12-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/crossref-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/crossref-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/crossref-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/crossref-mcp-server/releases/latest/download/crossref-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=crossref-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvY3Jvc3NyZWYtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22crossref-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads/crossref-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://crossref.caseyjhand.com/mcp](https://crossref.caseyjhand.com/mcp)

</div>

---

## Overview

An MCP server over the Crossref REST API. Resolve DOIs to full metadata records, search across ~155 million scholarly works by free text or structured filters, fetch outgoing reference lists, and look up journals, funders, and publishers. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `crossref_get_work` | Resolve a DOI to its full Crossref metadata record: title, authors, affiliations, abstract, journal, publication date, license, full-text links, and funder acknowledgements |
| `crossref_search_works` | Search the Crossref works index by free text and/or structured filters, with field-scoped query parameters, sort, field selection, and offset or cursor-based paging |
| `crossref_get_references` | Return the outgoing reference list for a DOI — the works cited by this paper, with citation strings and resolved DOIs where available |
| `crossref_search_journals` | Find Crossref journal records by ISSN or title query; optionally retrieve a page of the journal's most recent works |
| `crossref_search_funders` | Find funders in the Crossref Funder Registry by name, registry ID, or funder DOI; optionally retrieve a page of funded works |
| `crossref_get_member` | Resolve a Crossref member ID to its publisher record — name, owned DOI prefixes, DOI counts, and per-category metadata deposit coverage |
| `crossref_get_prefix` | Resolve a DOI prefix (e.g. `10.1038`) to its owning publisher, chaining into `crossref_get_member` |

## Capability reference

### `crossref_get_work` <sub>tool</sub>

- DOI validated against the `10.NNNN/suffix` regex before the upstream call
- Returns title, authors with affiliations, abstract (when deposited), container/journal, publication date, work type, ISSN, license URLs, full-text link URLs, and funder acknowledgements
- Author list paged by `offset`/`limit` (default 25, max 500); `authorCount` reports the full deposited total and a `nextOffset` continues when authors remain — every other field is returned in full on every page
- A funder or affiliation asserted only through the ROR registry (no name deposited) carries `ror` in place of `name`, never as a blank entry
- Publication date is the first of `published`, `published-print`, `published-online`, and `issued` (this tool only) that names a value; a date component Crossref records as unknown is omitted, along with everything less precise below it
- Outgoing references are reported as a count (`referencesCount`) — entries come from `crossref_get_references`; incoming citation count (`isReferencedByCount`) is included, but citing works are not exposed by Crossref — use OpenAlex for citation graphs

---

### `crossref_search_works` <sub>tool</sub>

- Free-text `query` plus a structured `filter` object using Crossref's hyphenated keys (`from-pub-date`, `type`, `funder`, `issn`, `has-abstract`, `directory: "DOAJ"`, etc.)
- Field-scoped parameters `queryTitle`, `queryAuthor`, `queryContainerTitle`, and `queryBibliographic` combine with `query` and with each other
- Sort by `relevance`, `score`, `is-referenced-by-count`, `published`, `deposited`, or other listed fields; `fields` narrows the payload (`DOI` is always returned)
- `authorLimit` caps authors per work (default 25, max 500); `authorCount` reports the full deposited total — chain a cut work's DOI into `crossref_get_work` for the rest
- Offset paging is capped at ~10K; `cursor="*"` starts deep paging via chained `nextCursor` tokens — cursor and offset cannot be combined
- A cursor walk ends on the page that omits `nextCursor` (Crossref keeps minting tokens past the end of a list); every empty page's `notice` names which of the three causes applies

---

### `crossref_get_references` <sub>tool</sub>

- Each reference carries its deposited citation string and, when Crossref has resolved it, a DOI for `crossref_get_work`
- Citation strings have formatting markup stripped and character references decoded; a bracketed span that isn't a recognized tag (a cited URL, a Miller index, a DOI fragment) is left exactly as deposited
- Paged by `offset`/`limit` (default 100, max 500); `referenceCount` is the full deposited total and `nextOffset` continues when more remain
- Coverage varies by publisher — pre-2000 works and non-participating publishers often have no indexed references
- Single-hop only; incoming citations are not available through Crossref — use OpenAlex for citation graphs

---

### `crossref_search_journals` <sub>tool</sub>

- `include_works: true` also returns a page of the journal's most recent works by publication date; requires an unambiguous journal — a title query matching more than one returns `ambiguous_journal`, naming candidates and ISSNs
- Returns journal title, publisher, ISSN-L, subject areas, and total DOI count
- Title-query results page by `offset` (ceiling `offset + rows ≤ 100,000`); the works list pages separately by `works_offset` (ceiling `≤ 10,000`) — a page that stalls at either ceiling carries a `notice` naming it
- `works_cursor="*"` pages the works list with no ceiling via chained `nextWorksCursor` tokens; a cursor walk always starts at the newest work and cannot combine with `works_offset > 0` (`works_cursor_offset_conflict`)
- A matched journal with no ISSN registered has no addressable works list — `include_works` is skipped with a `notice` rather than returning an empty list

---

### `crossref_search_funders` <sub>tool</sub>

- Accepts a name `query`, a bare registry ID (`100000001`), or a full funder DOI (`10.13039/100000001`, optionally behind a `doi:`/`https://doi.org/` prefix)
- `include_works: true` also returns a page of funded works; requires an unambiguous funder — a name query matching more than one returns `ambiguous_funder`, naming candidates and registry IDs
- Returns funder name, registry ID, country, and alternate names
- Name-query results page by `offset` (ceiling `≤ 100,000`); the funded-works list pages separately by `works_offset` (ceiling `≤ 10,000`) or, with no ceiling, `works_cursor="*"` chaining `nextWorksCursor` — a cursor walk starts at the newest work and cannot combine with `works_offset > 0`
- The funded-works list also counts works funded by the funder's registry descendants, which a `crossref_search_works` filter on `{"funder": "10.13039/<id>"}` does not
- A deprecated registry entry answers to its successor's name while counting only its own works — the response's `notice` names the superseding ID via `replacedBy`; the replacement is never followed automatically

---

### `crossref_get_member` <sub>tool</sub>

- Members are the organizations that register DOIs — this answers "what does this publisher publish, and how completely do they deposit metadata?"
- Returns primary name, alternate imprint names, owned DOI prefixes, DOI counts (total/current/backfile), a per-work-type breakdown, and per-category metadata deposit coverage (references, abstracts, ORCIDs, funders, licenses, and more) as current/backfile fractions
- Pair with `crossref_get_prefix` to resolve a DOI prefix to the member ID first

---

### `crossref_get_prefix` <sub>tool</sub>

- Accepts the registrant prefix of a DOI (e.g. `10.1038`, no `/suffix`)
- Returns the publisher name and numeric member ID — the ID chains directly into `crossref_get_member` for the full record
- The Crossref prefix record is thin by design (owner name and member link only); richer publisher data lives on the member record

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Crossref-specific:

- Polite-pool `User-Agent` header injected on every request — priority access via `CROSSREF_MAILTO`, keyless otherwise; no API token required
- Retry with exponential backoff on 429 (honoring `Retry-After`), 5xx, HTTP 408/504, and network failures; a malformed response body and a request that hits `CROSSREF_TIMEOUT_MS` are not retried
- Cursor-based deep paging on the works search and on both works sub-resources, for result sets beyond the offset cap
- Filter key validation enforces Crossref's hyphenated syntax (`has-abstract`, `has-references`, `from-pub-date`) and surfaces upstream validation errors with recovery hints
- Text normalization on every human-readable value: HTML character references decoded and whitespace collapsed; citation strings additionally have formatting markup stripped, so titles and abstracts read as plain text instead of raw JATS XML

Agent-friendly output:

- Provenance — identifiers, URLs, and dates are returned byte-exact while human-readable text is normalized, so a caller can trust `doi`, `issn`, and date fields without re-verification
- Graceful partial failure — an offset or cursor past the end of a list returns an empty array with a `notice` explaining why (query exhausted, offset past end, or cursor walk complete) instead of an error
- Discriminated output contracts — `nextCursor`, `nextOffset`, `works_cursor`, and `nextWorksCursor` continuation fields are present only when more data remains; their absence alone signals the list is exhausted
- Ambiguity handled explicitly — `ambiguous_journal` and `ambiguous_funder` list every candidate and its identifier in the error data rather than silently resolving to the first match

## Getting started

### Public Hosted Instance

A public instance is available at `https://crossref.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "crossref-mcp-server": {
      "type": "streamable-http",
      "url": "https://crossref.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

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

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
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
| `MCP_SESSION_MODE` | HTTP session mode: `auto`, `stateful`, or `stateless`. This server needs no multi-round input; Docker and `.env.example` pin `stateless`. The framework schema defaults to `auto`, which resolves to `stateful`. | `stateless` (deployment pin) |
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

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
