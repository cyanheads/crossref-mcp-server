#!/usr/bin/env node
/**
 * @fileoverview crossref-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { initCrossrefService } from './services/crossref/crossref-service.js';

await createApp({
  name: 'crossref-mcp-server',
  title: 'crossref-mcp-server',
  instructions:
    'Use the `crossref_*` tools for scholarly metadata from the Crossref REST API. Set `CROSSREF_MAILTO` (an email, no token) for faster polite-pool access. Works are keyed by DOI (`10.NNNN/suffix`), journals by ISSN, funders by a Funder Registry ID (`100000001`) or its full DOI (`10.13039/100000001`). Typical flow: `crossref_search_works` finds a DOI, then `crossref_get_work` for the full record or `crossref_get_references` for outgoing citations; `crossref_search_journals` and `crossref_search_funders` cover venues and funders. No incoming citations (use OpenAlex). `crossref_search_works` pages past ~10K with `cursor="*"`, and the works lists on `crossref_search_journals` / `crossref_search_funders` page the same way with `works_cursor="*"`; the journal and funder name searches themselves take `offset` only. Each response names its own ceiling and continuation, and a cursor walk ends on the page that omits its continuation token: Crossref keeps minting one past the end of a list, so the token is withheld on an empty page rather than relayed.',
  tools: [...allToolDefinitions],
  resources: [],
  prompts: [],
  landing: {
    // Public catalog: serve full tool inventory to unauthenticated callers
    // even when MCP_AUTH_MODE is jwt or oauth.
    requireAuth: false,
  },
  setup() {
    initCrossrefService();
  },
});
