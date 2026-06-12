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
