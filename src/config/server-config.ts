/**
 * @fileoverview Server-specific configuration for the legislation.gov.uk client.
 * Lazy-parsed from environment variables; framework config (transport, logging,
 * auth) is handled by @cyanheads/mcp-ts-core.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  contact: z
    .string()
    .trim()
    .optional()
    .describe(
      'Email or URL appended to the User-Agent so legislation.gov.uk can reach the operator',
    ),
  minRequestGapMs: z.coerce
    .number()
    .int()
    .min(250)
    .default(1000)
    .describe('Minimum gap between upstream request starts, in ms (process-wide)'),
  cacheMaxMb: z.coerce
    .number()
    .int()
    .min(8)
    .max(1024)
    .default(64)
    .describe('Response cache size bound, in MB'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Parses and caches the server config on first call. */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    contact: 'UK_LEGISLATION_CONTACT',
    minRequestGapMs: 'UK_LEGISLATION_MIN_REQUEST_GAP_MS',
    cacheMaxMb: 'UK_LEGISLATION_CACHE_MAX_MB',
  });
  return _config;
}
