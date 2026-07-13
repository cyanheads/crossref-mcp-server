<div align="center">
  <h1>@cyanheads/crossref-mcp-server</h1>
  <p><b>Resolve DOIs, search ~155M scholarly works, fetch references, and look up publishers via the Crossref REST API. STDIO or Streamable HTTP.</b>
  <div>7 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/crossref-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/crossref-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/crossref-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.14-blueviolet.svg?style=flat-square)](https://bun.sh/)

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/crossref-mcp-server/releases/latest/download/crossref-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=crossref-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvY3Jvc3NyZWYtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22crossref-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads/crossref-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Tools

Seven tools for working with Crossref data — DOI resolution, full-text search across all scholarly works, outgoing reference lists, and journal, funder, and publisher lookup:

| Tool | Description |
|:-----|:------------|
| `crossref_get_work` | Resolve a DOI to its full Crossref metadata record: title, authors, affiliations, abstract (when deposited), journal, publication date, type, license, full-text links, funder acknowledgements, and outgoing reference list |
| `crossref_search_works` | Search the Crossref works index by free text and/or structured filters. Supports sort, field selection, and cursor-based deep paging. |
| `crossref_get_references` | Return the outgoing reference list for a DOI — the works cited by this paper, with raw citation strings and resolved DOIs where available |
| `crossref_search_journals` | Find Crossref journal records by ISSN or title query; optionally retrieve the journal's most recent works by publication date |
| `crossref_search_funders` | Find funders registered in the Crossref Funder Registry by name or funder DOI; optionally retrieve funded works |
| `crossref_get_member` | Resolve a Crossref member ID to its publisher record — name, owned DOI prefixes, DOI counts, per-work-type breakdown, and per-category metadata deposit coverage |
| `crossref_get_prefix` | Resolve a DOI prefix (e.g. `10.1038`) to its owning publisher — name and member ID, chaining into `crossref_get_member` |

### `crossref_get_work`

Resolve a DOI to its canonical Crossref record.

- DOI validated against `10.NNNN/suffix` regex before the upstream call
- Returns title, authors with affiliations, abstract (when deposited), container/journal, publication date, work type, ISSN, license URLs, full-text link URLs, and funder acknowledgements
- Incoming citation count (`is-referenced-by-count`) is included; citing works are not — Crossref does not expose that data. Use OpenAlex for citation graphs.

---

### `crossref_search_works`

Search across ~155M Crossref-registered works.

- Free-text `query` plus a structured `filter` object using Crossref's hyphen-separated key syntax: `from-pub-date`, `until-pub-date`, `type`, `funder`, `issn`, `member`, `has-abstract`, `has-references`, `has-full-text`, `directory` (use `DOAJ` to restrict to open-access content)
- Field-specific query parameters scope matching beyond the generic `query`: `queryTitle`, `queryAuthor`, `queryContainerTitle` (journal/book name), and `queryBibliographic` (whole-citation match to resolve a known reference to its DOI) — all combine with each other and with `query`
- Sort by `relevance`, `is-referenced-by-count`, `published`, `deposited`, or `score`
- `fields` parameter narrows response payload — useful for large result sets
- Offset paging up to ~10K results; deep paging requires `cursor=*` on the first call, then pass the returned `nextCursor` token. Cursor and offset cannot be combined.

---

### `crossref_get_references`

Fetch the outgoing reference list for a DOI.

- Each reference includes its raw citation string and, where Crossref has resolved it, a DOI for follow-up lookup
- Coverage varies by publisher — pre-2000 literature and non-participating publishers may have no reference list
- Single-hop only; agents that need N-hop traversal chain calls explicitly

---

### `crossref_search_journals`

Find journal records by ISSN or title.

- `include_works: true` triggers a second upstream call to fetch the journal's most recent works by publication date
- Returns journal title, publisher, ISSN-L, subject areas, and total DOI count

---

### `crossref_search_funders`

Find funders in the Crossref Funder Registry.

- Accepts a name query or a direct funder DOI
- `include_works: true` retrieves funded works for the matched funder
- Returns funder name, DOI, country, and alternate names

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
- `withRetry`: 3 attempts, exponential backoff, handles both 429 and 503 responses
- Cursor-based deep paging for result sets beyond the ~10K offset cap
- Filter key validation: Crossref uses hyphens (`has-abstract`, `has-references`, `from-pub-date`); the server enforces correct syntax and surfaces API validation errors with actionable recovery hints

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
| `CROSSREF_TIMEOUT_MS` | Per-request timeout in milliseconds. | `10000` |
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
