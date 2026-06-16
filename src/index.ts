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
    'Use the `crossref_*` tools for scholarly metadata from the Crossref REST API. Set `CROSSREF_MAILTO` (an email, no token) for faster polite-pool access. Works are keyed by DOI (`10.NNNN/suffix`), journals by ISSN, funders by Funder Registry DOI. Typical flow: `crossref_search_works` finds a DOI, then `crossref_get_work` for the full record or `crossref_get_references` for outgoing citations; `crossref_search_journals` and `crossref_search_funders` cover venues and funders. No incoming citations (use OpenAlex); page past ~10K with `cursor="*"`.',
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
