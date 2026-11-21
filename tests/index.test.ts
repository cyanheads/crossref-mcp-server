/**
 * @fileoverview The options `src/index.ts` hands `createApp`, read by importing the entry point
 * against a stubbed `createApp`. The server `instructions` reach every client on `initialize`,
 * and they are built before the framework loads `.env`, so they carry nothing that depends on
 * the server's configuration — and no advice a caller, who cannot configure the server, could act on.
 * @module tests/index.test
 */

import { describe, expect, it, vi } from 'vitest';

const { createApp } = vi.hoisted(() => ({ createApp: vi.fn() }));

vi.mock('@cyanheads/mcp-ts-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core')>()),
  createApp,
}));

describe('server instructions', () => {
  it('tell callers nothing about configuring the polite-pool mailto', async () => {
    await import('@/index.js');

    const instructions: unknown = createApp.mock.calls[0]?.[0]?.instructions;
    expect(typeof instructions).toBe('string');
    expect(instructions).not.toContain('CROSSREF_MAILTO');
    expect(instructions).not.toMatch(/polite/i);
  });
});
