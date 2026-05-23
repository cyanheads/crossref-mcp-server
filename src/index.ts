#!/usr/bin/env node
/**
 * @fileoverview crossref-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { setCanvas } from './services/canvas-accessor.js';
import { initCrossrefService } from './services/crossref/crossref-service.js';

await createApp({
  tools: [...allToolDefinitions],
  resources: [],
  prompts: [],
  setup(core) {
    initCrossrefService();
    setCanvas(core.canvas);
  },
});
