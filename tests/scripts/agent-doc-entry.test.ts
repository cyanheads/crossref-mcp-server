/**
 * @fileoverview The `.mcpb` agent-doc selector shared by `scripts/clean-mcpb.ts` (the strip) and
 * `scripts/lint-packaging.ts` (the post-bundle check). It removes agent skill trees only at an
 * installed package's root, so the MCP SDK's `dist/ext/skills/` runtime modules survive the
 * clean and a bundle missing them never passes the check (cyanheads/mcp-ts-core#794). Both
 * scripts load by URL at run time: `lint-packaging.ts` carries a repo-only fallback import that
 * `tsc` cannot resolve in this project (cyanheads/mcp-ts-core#797).
 * @module tests/scripts/agent-doc-entry.test
 */

import { describe, expect, it } from 'vitest';

interface AgentDocSelector {
  AGENT_DOC_ENTRY: RegExp;
}

interface CleanMcpb extends AgentDocSelector {
  filterAgentDocEntries(entries: string[]): string[];
}

const scriptUrl = (name: string) => new URL(`../../scripts/${name}`, import.meta.url).href;
const cleanMcpb: CleanMcpb = await import(scriptUrl('clean-mcpb.ts'));
const lintPackaging: AgentDocSelector = await import(scriptUrl('lint-packaging.ts'));

/** Runtime modules nested under a `skills/` directory inside a package. */
const RUNTIME_ENTRIES = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/',
  'node_modules/@cyanheads/mcp-ts-core/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/some-pkg/lib/.claude/settings.js',
  // A package named `skills` is a package, not an agent-doc tree.
  'node_modules/skills/index.js',
  'node_modules/@acme/skills/index.js',
];

/** Agent docs a dependency ships at its package root, and stray SKILL.md files. */
const AGENT_DOC_ENTRIES = [
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/api-utils/references/formatting.md',
  'node_modules/dotenv/skills/dotenv/SKILL.md',
  'node_modules/dotenv/skills/',
  'node_modules/some-pkg/.claude/settings.json',
  'node_modules/@acme/tool/.agents/skills/x/SKILL.md',
  'node_modules/a/node_modules/@acme/tool/skills/guide.md',
  'node_modules/a/node_modules/b/framework-skills/setup/SKILL.md',
  'node_modules/some-pkg/docs/SKILL.md',
];

describe.each([
  ['clean-mcpb.ts', cleanMcpb],
  ['lint-packaging.ts', lintPackaging],
])('%s AGENT_DOC_ENTRY', (_name, script) => {
  it.each(RUNTIME_ENTRIES)('keeps runtime entry %s', (entry) => {
    expect(script.AGENT_DOC_ENTRY.test(entry)).toBe(false);
  });

  it.each(AGENT_DOC_ENTRIES)('selects agent doc %s', (entry) => {
    expect(script.AGENT_DOC_ENTRY.test(entry)).toBe(true);
  });

  it('leaves project-root entries alone', () => {
    expect(script.AGENT_DOC_ENTRY.test('dist/index.js')).toBe(false);
    expect(script.AGENT_DOC_ENTRY.test('skills/crossref/SKILL.md')).toBe(false);
  });
});

describe('clean-mcpb filterAgentDocEntries', () => {
  it('strips exactly the agent docs from a mixed listing', () => {
    expect(cleanMcpb.filterAgentDocEntries([...RUNTIME_ENTRIES, ...AGENT_DOC_ENTRIES])).toEqual(
      AGENT_DOC_ENTRIES,
    );
  });
});

describe('selector pair', () => {
  it('is the same literal in both scripts', () => {
    expect(cleanMcpb.AGENT_DOC_ENTRY.source).toBe(lintPackaging.AGENT_DOC_ENTRY.source);
    expect(cleanMcpb.AGENT_DOC_ENTRY.flags).toBe(lintPackaging.AGENT_DOC_ENTRY.flags);
  });
});
