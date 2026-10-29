/**
 * @fileoverview Tests for the bundle agent-doc selector shared by
 * `scripts/clean-mcpb.ts` (the strip step) and `scripts/lint-packaging.ts`
 * (the post-bundle check): a `skills/`-style tree is removed only at an
 * installed package's root, so the MCP SDK's runtime `dist/ext/skills/`
 * modules survive the clean and pass the check. The linter is loaded by URL at
 * run time — its repo-only fallback import does not resolve in this project,
 * so a static import would fail `tsc` (cyanheads/mcp-ts-core#797).
 * @module tests/scripts/agent-doc-entry.test
 */

import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries, AGENT_DOC_ENTRY as STRIP_ENTRY } from '../../scripts/clean-mcpb.js';

const RUNTIME = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/outer/node_modules/@modelcontextprotocol/server/dist/ext/skills/loader.mjs',
  'node_modules/example/dist/skills/runtime.js',
  'node_modules/@scope/skills/index.js',
  'node_modules/skills/index.js',
  'skills/uk-legislation-guide/SKILL.md',
  'dist/index.js',
];

const AGENT_DOCS = [
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/references/patterns.md',
  'node_modules/example/skills/guide/reference.md',
  'node_modules/@scope/example/skills/guide/reference.md',
  'node_modules/outer/node_modules/@scope/example/skills/guide/reference.md',
  'node_modules/outer/node_modules/inner/.claude/settings.json',
  'node_modules/example/.claude/settings.json',
  'node_modules/example/.agents/guide.md',
  'node_modules/example/docs/SKILL.md',
  'node_modules/example/SKILL.md',
];

const ALL = [...RUNTIME, ...AGENT_DOCS];

describe('AGENT_DOC_ENTRY', () => {
  it('selects package-root agent docs and keeps nested runtime skills modules', () => {
    expect(filterAgentDocEntries(ALL)).toEqual(AGENT_DOCS);
  });

  it('matches the post-bundle linter selector entry for entry', async () => {
    const linterUrl = new URL('../../scripts/lint-packaging.ts', import.meta.url).href;
    const linter: { AGENT_DOC_ENTRY: RegExp } = await import(linterUrl);
    expect(linter.AGENT_DOC_ENTRY.source).toBe(STRIP_ENTRY.source);
    expect(ALL.filter((entry) => linter.AGENT_DOC_ENTRY.test(entry))).toEqual(AGENT_DOCS);
  });
});
