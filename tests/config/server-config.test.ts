/**
 * @fileoverview Environment boundary coverage for Crossref configuration.
 * @module tests/config/server-config
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Crossref environment configuration', () => {
  it.each([undefined, '', `\${user_config.mailto}`])(
    'treats an absent contact %s as optional',
    async (mailto) => {
      vi.resetModules();
      vi.stubEnv('CROSSREF_MAILTO', mailto);
      vi.stubEnv('CROSSREF_BASE_URL', undefined);
      vi.stubEnv('CROSSREF_TIMEOUT_MS', undefined);
      const { getServerConfig } = await import('../../src/config/server-config.js');
      expect(getServerConfig()).toEqual({
        mailto: undefined,
        baseUrl: 'https://api.crossref.org',
        timeoutMs: 10000,
      });
    },
  );

  it('preserves configured values', async () => {
    vi.resetModules();
    vi.stubEnv('CROSSREF_MAILTO', 'casey@caseyjhand.com');
    vi.stubEnv('CROSSREF_BASE_URL', 'https://api.crossref.org');
    vi.stubEnv('CROSSREF_TIMEOUT_MS', '2500');
    const { getServerConfig } = await import('../../src/config/server-config.js');
    expect(getServerConfig()).toEqual({
      mailto: 'casey@caseyjhand.com',
      baseUrl: 'https://api.crossref.org',
      timeoutMs: 2500,
    });
  });

  it.each(['', `\${user_config.value}`])(
    'defaults unset base URL and timeout: %s',
    async (value) => {
      vi.resetModules();
      vi.stubEnv('CROSSREF_MAILTO', undefined);
      vi.stubEnv('CROSSREF_BASE_URL', value);
      vi.stubEnv('CROSSREF_TIMEOUT_MS', value);
      const { getServerConfig } = await import('../../src/config/server-config.js');
      expect(getServerConfig()).toEqual({
        mailto: undefined,
        baseUrl: 'https://api.crossref.org',
        timeoutMs: 10000,
      });
    },
  );

  it('rejects a malformed contact instead of hiding it', async () => {
    vi.resetModules();
    vi.stubEnv('CROSSREF_MAILTO', 'not-an-email');
    const { getServerConfig } = await import('../../src/config/server-config.js');
    expect(() => getServerConfig()).toThrow(/CROSSREF_MAILTO/);
  });

  it.each([undefined, 'casey@caseyjhand.com'])(
    'routes startup guidance through the logger for contact %s',
    async (mailto) => {
      vi.resetModules();
      vi.stubEnv('CROSSREF_MAILTO', mailto);
      const { logger } = await import('@cyanheads/mcp-ts-core/utils');
      const warning = vi.spyOn(logger, 'warning').mockImplementation(() => {});
      const { initCrossrefService } = await import(
        '../../src/services/crossref/crossref-service.js'
      );
      initCrossrefService();
      if (mailto) expect(warning).not.toHaveBeenCalled();
      else
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('CROSSREF_MAILTO is not set'));
    },
  );
});
