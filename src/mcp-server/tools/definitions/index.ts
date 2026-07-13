/**
 * @fileoverview Barrel export for all crossref-mcp-server tool definitions.
 * @module mcp-server/tools/definitions/index
 */

export { getMemberTool } from './get-member.tool.js';
export { getPrefixTool } from './get-prefix.tool.js';
export { getReferencesTool } from './get-references.tool.js';
export { getWorkTool } from './get-work.tool.js';
export { searchFundersTool } from './search-funders.tool.js';
export { searchJournalsTool } from './search-journals.tool.js';
export { searchWorksTool } from './search-works.tool.js';

import { getMemberTool } from './get-member.tool.js';
import { getPrefixTool } from './get-prefix.tool.js';
import { getReferencesTool } from './get-references.tool.js';
import { getWorkTool } from './get-work.tool.js';
import { searchFundersTool } from './search-funders.tool.js';
import { searchJournalsTool } from './search-journals.tool.js';
import { searchWorksTool } from './search-works.tool.js';

export const allToolDefinitions = [
  getWorkTool,
  getReferencesTool,
  searchWorksTool,
  searchJournalsTool,
  searchFundersTool,
  getMemberTool,
  getPrefixTool,
] as const;
