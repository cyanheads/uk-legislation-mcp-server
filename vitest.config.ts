/**
 * @fileoverview Vitest config for the consumer server. Uses Vitest `projects`
 * so you can split suites (unit/smoke/integration/fuzz) and run each with
 * `--project <name>` as the surface grows. Extends the framework's base config
 * for shared `resolve`, `ssr`, and coverage settings.
 *
 * @module vitest.config
 */

import coreConfig from '@cyanheads/mcp-ts-core/vitest.config';
import { defineConfig, mergeConfig } from 'vitest/config';

const alias = { '@/': new URL('./src/', import.meta.url).pathname };

/**
 * Under Bun (`bun --bun run test`) the suite runs on worker threads: Vitest
 * 5.1's forks pool calls `child.channel.unref()`, which Bun's child processes
 * lack, so no fork starts. Node keeps the base config's isolated forks. No
 * test here spawns a worker thread or changes `TZ`, which would need forks.
 */
const bunPool = process.versions.bun ? { pool: 'threads' as const } : {};

export default mergeConfig(
  coreConfig,
  defineConfig({
    resolve: { alias },
    test: {
      ...bunPool,
      /** Blocks the global fetch and outbound sockets in every worker; upstream is reached only through the injected fake. */
      setupFiles: ['tests/setup/network-tripwire.ts'],
      projects: [
        {
          extends: true,
          test: {
            name: 'unit',
            include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
            exclude: ['tests/smoke/**', 'tests/integration/**', 'tests/fuzz/**'],
          },
        },
        {
          extends: true,
          test: {
            name: 'smoke',
            include: ['tests/smoke/**/*.test.ts'],
          },
        },
        {
          extends: true,
          test: {
            name: 'integration',
            include: ['tests/integration/**/*.test.ts'],
            maxWorkers: 1,
            testTimeout: 30_000,
          },
        },
        {
          extends: true,
          test: {
            name: 'fuzz',
            include: ['tests/fuzz/**/*.test.ts'],
            testTimeout: 15_000,
          },
        },
      ],
    },
  }),
);
