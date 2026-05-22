#!/usr/bin/env node
/**
 * @fileoverview crossref-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { setCanvas } from './services/canvas-accessor.js';
import { initCrossrefService } from './services/crossref/crossref-service.js';

await createApp({
  tools: [...allToolDefinitions],
  resources: [],
  prompts: [],
  setup(core) {
    const cfg = getServerConfig();
    if (!cfg.mailto) {
      core.logger.warning(
        'CROSSREF_MAILTO is not set — using the anonymous pool with stricter rate limits. ' +
          'Set CROSSREF_MAILTO to your contact email for polite-pool priority access.',
      );
    }
    initCrossrefService();
    setCanvas(core.canvas);
  },
});
