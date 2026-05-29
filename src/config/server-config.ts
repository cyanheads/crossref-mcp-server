/**
 * @fileoverview Server-specific configuration for crossref-mcp-server.
 * Parses CROSSREF_MAILTO, CROSSREF_BASE_URL, and CROSSREF_TIMEOUT_MS from the environment.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  mailto: z.preprocess(
    // Strip MCPB placeholder literals (${user_config.X}) to undefined so
    // the z.email() validator doesn't crash when the optional field is
    // left blank in a bundle install.
    (v) => (typeof v === 'string' && /^\$\{[^}]+\}$/.test(v) ? undefined : v),
    z
      .string()
      .email()
      .optional()
      .describe('Contact email embedded in the polite-pool User-Agent header'),
  ),
  baseUrl: z.string().url().default('https://api.crossref.org').describe('Crossref API base URL'),
  timeoutMs: z.coerce
    .number()
    .min(1000)
    .max(60_000)
    .default(10_000)
    .describe('Per-request timeout in milliseconds'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    mailto: 'CROSSREF_MAILTO',
    baseUrl: 'CROSSREF_BASE_URL',
    timeoutMs: 'CROSSREF_TIMEOUT_MS',
  });
  return _config;
}
