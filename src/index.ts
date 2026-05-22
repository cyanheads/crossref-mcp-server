#!/usr/bin/env node
/**
 * @fileoverview crossref-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { echoTool } from './mcp-server/tools/definitions/echo.tool.js';

await createApp({
  tools: [echoTool],
  resources: [],
  prompts: [],
});
