# Agent Protocol

**Server:** @cyanheads/crossref-mcp-server
**Version:** 0.3.6
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.11.1`
**Engines:** Bun ≥1.3.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/sdk` ^1.30.0
**Zod:** ^4.4.3

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## What's Next?

When the user asks what to do next or needs direction, suggest relevant options based on current project state:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Domain

crossref-mcp-server wraps the [Crossref REST API](https://api.crossref.org/) to expose canonical scholarly metadata for ~155 million registered works (journal articles, books, book chapters, conference papers, preprints, datasets, components). It is the authoritative source for DOI-registered metadata — titles, authors, affiliations, abstracts (where deposited), licenses, full-text links, funder acknowledgements, and outgoing reference lists.

**Pairs with:** pubmed-mcp-server (biomedical abstracts/MeSH), openalex-mcp-server (citation graphs, topics, analytics), arxiv-mcp-server (preprints — their DOIs resolve through Crossref), biorxiv-mcp-server (preprints — same).

### Key domain constraints

- **Polite-pool `mailto` is optional but recommended.** Every request includes `User-Agent: crossref-mcp-server/0.3.6 (mailto:<CROSSREF_MAILTO>)` when set. Without it, the server starts but logs a warning and uses the anonymous pool with stricter rate limits. Polite-pool access requires no token — just the email in the header.
- **No incoming citations.** Crossref does not expose which works cite a given DOI. Redirect to OpenAlex for citation counts or citation graphs.
- **Abstract coverage is incomplete.** Abstracts are deposited voluntarily; many records — especially older works and books — have none.
- **Reference list coverage varies.** Outgoing references are only present for publisher participants; pre-2000 literature has low coverage.
- **Offset paging is capped at ~10K** on `/works` and on both works sub-resources (100K on the `/journals` and `/funders` name searches). Deep paging requires `cursor=*` on the first request, then chaining `next-cursor` tokens; the name-search routes do not accept a cursor. Cursor and offset cannot be combined.
- **A cursor walk is ended by an empty page, never by upstream.** Crossref keeps minting a `next-cursor` past the end of a list and hands back the token that produced the empty page, so every cursor surface withholds its continuation token once a page comes back empty.
- **`select=` works on `/works` (search) only.** It is not supported on `/works/{doi}` (single-fetch). `crossref_get_references` fetches the full record and extracts `reference[]` client-side.
- **Filter keys use hyphens.** e.g. `has-abstract`, `has-references`, `has-full-text`, `from-pub-date`. No `is_open_access` filter exists — use `directory:DOAJ` for open-access content.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit` / `ctx.sample`** for presence before calling.
- **Secrets in env vars only** — never hardcoded.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { getCrossrefService } from '@/services/crossref/crossref-service.js';

export const getWorkTool = tool('crossref_get_work', {
  description: 'Resolve a DOI to its full Crossref metadata record.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    doi: z
      .string()
      .regex(/^10\.\d{4,9}\/\S+$/)
      .describe('DOI in the format "10.NNNN/suffix", e.g. "10.1038/nature12373"'),
  }),

  output: z.object({
    doi: z.string().describe('Canonical DOI'),
    title: z.string().describe('Work title'),
    type: z.string().describe('Work type (e.g. journal-article, book-chapter)'),
    authors: z.array(z.object({
      given: z.string().optional().describe('Given name'),
      family: z.string().optional().describe('Family name'),
    })).describe('Author list'),
    isReferencedByCount: z.number().describe('Incoming citation count (works citing this DOI)'),
  }),

  errors: [
    { reason: 'doi_not_found', code: JsonRpcErrorCode.NotFound,
      when: 'Valid DOI format but no Crossref record',
      recovery: 'Verify the DOI or use crossref_search_works to find similar works.' },
    { reason: 'invalid_doi', code: JsonRpcErrorCode.InvalidParams,
      when: 'DOI fails regex validation',
      recovery: 'Fix the DOI format: must start with "10." followed by 4+ digits and a slash.' },
  ],

  async handler(input, ctx) {
    ctx.log.info('Executing crossref_get_work', { doi: input.doi });
    const svc = getCrossrefService();
    const work = await svc.getWork(input.doi);
    if (!work) throw ctx.fail('doi_not_found', `No record for DOI ${input.doi}`);
    return work;
  },

  format: (result) => [{
    type: 'text',
    text: `**${result.title}**\nDOI: ${result.doi} | Type: ${result.type} | Cited by: ${result.isReferencedByCount}`,
  }],
});
```

### Server config

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  mailto: z.preprocess(
    // Strip MCPB placeholder literals (${user_config.X}) to undefined so
    // z.email() doesn't crash when the optional field is blank in a bundle install.
    (v) => (typeof v === 'string' && /^\$\{[^}]+\}$/.test(v) ? undefined : v),
    z.string().email().optional().describe('Contact email embedded in the polite-pool User-Agent header'),
  ),
  baseUrl: z.string().url().default('https://api.crossref.org').describe('Crossref API base URL'),
  timeoutMs: z.coerce.number().min(1000).max(60000).default(10000).describe('Per-request timeout in ms'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    mailto: 'CROSSREF_MAILTO',
    baseUrl: 'CROSSREF_BASE_URL',
    timeoutMs: 'CROSSREF_TIMEOUT_MS',
  });
  return _config;
}
```

`parseEnvConfig` maps Zod schema paths → env var names so validation errors name the actual variable (`CROSSREF_MAILTO`) not the path (`mailto`). Throws `ConfigurationError`, printed as a clean startup banner.

### Server instructions

`createApp({ instructions })` — optional server-level orientation, sent to clients on every `initialize` as session-level context. Use it for deployment guidance (connection aliases, regional notes, scope hints) instead of repeating the same context across tool descriptions. Client adoption is uneven, but there's no downside when set.

---

## Context

Handlers receive a unified `ctx` object. Key properties used in this server:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.list(prefix, { cursor, limit })`. Accepts any serializable value. |
| `ctx.elicit` | Ask user for structured input. **Check for presence first:** `if (ctx.elicit) { ... }` |
| `ctx.sample` | Request LLM completion from the client. **Check for presence first:** `if (ctx.sample) { ... }` |
| `ctx.signal` | `AbortSignal` for cancellation. |
| `ctx.progress` | Task progress (present when `task: true`) — `.setTotal(n)`, `.increment()`, `.update(message)`. |
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | Tenant ID from JWT or `'default'` for stdio. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability, linter enforces conformance against the handler body. `recovery` is required descriptive metadata for the agent's next move (≥ 5 words, lint-validated); for the wire `data.recovery.hint` (mirrored into `content[]` text), pass explicitly at the throw site when dynamic context matters: `ctx.fail('reason', msg, { recovery: { hint: '...' } })`. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely and don't need declaring.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

errors: [
  { reason: 'doi_not_found', code: JsonRpcErrorCode.NotFound,
    when: 'Valid DOI format but no Crossref record',
    recovery: 'Verify the DOI or use crossref_search_works to find similar works.' },
],
async handler(input, ctx) {
  const work = await svc.getWork(input.doi, ctx);
  if (!work) throw ctx.fail('doi_not_found', `No record for DOI ${input.doi}`);
  return work;
}
```

**Fallback (no contract entry fits):** throw via factories or plain `Error`.

```ts
// Error factories — explicit code
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('No record for DOI', { doi });
throw serviceUnavailable('Crossref API unavailable', { url }, { cause: err });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point
  config/
    server-config.ts                    # CROSSREF_MAILTO, CROSSREF_BASE_URL, CROSSREF_TIMEOUT_MS
  services/
    crossref/
      crossref-service.ts               # HTTP client, polite-pool User-Agent, retry, pagination
      types.ts                          # Crossref domain types (Work, Reference, Journal, Funder)
      upstream-errors.ts                # Upstream/transport error contract + throw-site factory
  mcp-server/
    tools/definitions/
      get-work.tool.ts                  # crossref_get_work
      get-references.tool.ts            # crossref_get_references
      search-works.tool.ts              # crossref_search_works
      search-journals.tool.ts           # crossref_search_journals
      search-funders.tool.ts            # crossref_search_funders
      get-member.tool.ts                # crossref_get_member
      get-prefix.tool.ts                # crossref_get_prefix
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `get-work.tool.ts` |
| Tool/resource/prompt names | snake_case | `crossref_get_work` |
| Directories | kebab-case | `src/services/crossref/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Resolve a DOI to its full Crossref metadata record.'` |

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Run `bun run list-skills` to get an indexed list of all available local skills with their paths.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a versioned commit + annotated tag — version bump, changelog, verify, tag. Local only. |
| `release-and-publish` | Push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `techniques` | Catalog of response/data-shaping techniques — overflow handling, payload shaping, retrieval patterns |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService: persistent self-refreshing local mirror (embedded SQLite + FTS5) of a bulk upstream dataset — Tier 3 opt-in |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-05-21`).

---

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting |
| `bun run test` | Run tests |
| `bun run lint:mcp` | Validate MCP definitions against spec |
| `bun run list-skills` | List available local skills with paths |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run bundle` | Build and pack as `.mcpb` for one-click Claude Desktop install |
| `bun run audit:refresh` | Delete `bun.lock`, reinstall, re-audit. Use when `devcheck` flags a transitive advisory — stale lockfile can mask already-patched deps. If advisory survives, it's real. |

---

## Bundling

`bun run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. MCPB is stdio-only — HTTP deployments are unaffected. Consumers who don't need it can delete `manifest.json` and `.mcpbignore`; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release. At release, author the per-version file with a concrete version and date, then run `bun run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** regenerated by `bun run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getCrossrefService } from '@/services/crossref/crossref-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] Crossref wrapping: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields (abstracts, reference lists, and affiliations are frequently absent)
- [ ] Crossref wrapping: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] Crossref wrapping: tests include at least one sparse payload case with omitted upstream fields (no abstract, no references, no affiliations)
- [ ] `CROSSREF_MAILTO` startup warning logged when env var is absent
- [ ] Filter keys in `crossref_search_works` use hyphens (e.g. `has-abstract`), not underscores
- [ ] `select=` parameter only passed to `/works` (search), never to `/works/{doi}` (single-fetch)
- [ ] `crossref_get_references` extracts `reference[]` from the full `/works/{doi}` response body, not via a `select` shortcut
- [ ] Cursor and offset cannot be combined — throw `cursor_offset_conflict` (`crossref_search_works`) or `works_cursor_offset_conflict` (the journal/funder works sub-resources) if both are supplied
- [ ] Cursor continuation tokens (`nextCursor`, `nextWorksCursor`) are withheld on an empty page — the guard keys on the page's item count, never on `totalResults`
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = package name; `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key matches `package.json` name; env vars added for any required API keys
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; inline `mcpServers` entry with server name key, env vars for any required API keys
- [ ] `bun run devcheck` passes
