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
    'Use the `crossref_*` tools for scholarly metadata from the Crossref REST API. Set `CROSSREF_MAILTO` (an email, no token) for faster polite-pool access. Works are keyed by DOI (`10.NNNN/suffix`), journals by ISSN, funders by a Funder Registry ID (`100000001`) or its full DOI (`10.13039/100000001`). Typical flow: `crossref_search_works` finds a DOI, then `crossref_get_work` for the full record or `crossref_get_references` for outgoing citations; `crossref_search_journals` and `crossref_search_funders` cover venues and funders. No incoming citations (use OpenAlex). `crossref_search_works` pages past ~10K with `cursor="*"`; the journal and funder searches page by `offset` instead and each response names its own ceiling and continuation.',
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
