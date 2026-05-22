# crossref-mcp-server — Idea

Pre-design seed. Feeds into `design-mcp-server` to produce `docs/design.md`.

## Domain

Crossref — the largest DOI registration agency. Canonical metadata for ~155M scholarly works: journal articles, books, book chapters, conference papers, preprints, datasets, components. Each work carries title, authors, affiliations, abstract (when deposited), references (outgoing citations), funders, license info, and links to full text.

## Data source

- **API:** https://api.crossref.org/
- **Auth:** none required, but "polite pool" — send `User-Agent: server-name/version (mailto:contact)` for better rate limits and priority
- **Rate limit:** best-effort, soft throttling; polite pool gets first-class service
- **Format:** JSON; DOI is primary key; entities: works, funders, members (publishers), journals (ISSN), types

## User goals

- Resolve a DOI to full metadata (title, authors, journal, references, license, full-text links)
- Search by title, author, journal, year — filterable
- Pull a work's outgoing reference list (citations from this paper)
- Find a journal by ISSN or name → list its recent works
- Find a funder → list funded works
- Filter to OA, licensed-for-reuse, has-references, has-abstract, etc.

## Tool sketch

| Tool | Purpose |
|:-----|:--------|
| `crossref_get_work` | DOI → full record (metadata, references, license, full-text links) |
| `crossref_search_works` | Search across works with filters (year, type, has-abstract, has-references, OA, funder, member) |
| `crossref_get_references` | Outgoing reference list for a DOI; structured citations resolved to DOIs where available |
| `crossref_search_journals` | Resolve a journal name/ISSN to a Crossref journal record + recent works |
| `crossref_search_funders` | Resolve a funder name → funder ID → funded works |

## Pairs with

- **pubmed-mcp-server** — biomedical-specific; Crossref is broader (all disciplines)
- **openalex-mcp-server** — OpenAlex builds on Crossref + adds analytics/topics/concepts; use OpenAlex for graph queries, Crossref for canonical metadata
- **arxiv-mcp-server** — arXiv DOIs resolve through Crossref
- **biorxiv-mcp-server** — preprint DOIs carry through Crossref

## Open questions

- Polite-pool mailto: take from env per-tenant, or a server-level contact in config?
- Citation graph traversal — does `get_references` follow N hops, or single-hop only and let the agent chain?
- Tabular spillover for large search result sets — DataCanvas
- Incoming citations: Crossref doesn't expose them (use OpenAlex for that). Document the boundary in tool descriptions.
