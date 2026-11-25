/**
 * @fileoverview Tests for the bundle agent-doc selector shared by
 * `scripts/clean-mcpb.ts` (the strip step) and `scripts/lint-packaging.ts`
 * (the post-bundle check): a `skills/`-style tree, `AGENTS.md`, or `CLAUDE.md`
 * is removed only at an installed package's root and `SKILL.md` anywhere under
 * `node_modules/`, so the MCP SDK's runtime `dist/ext/skills/` modules survive
 * the clean and pass the check. The framework asserts the pair matches only in
 * its own repository; this suite holds the copies in this project to it.
 * @module tests/scripts/agent-doc-entry.test
 */

import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries, AGENT_DOC_ENTRY as STRIP_ENTRY } from '../../scripts/clean-mcpb.js';
import { AGENT_DOC_ENTRY as CHECK_ENTRY } from '../../scripts/lint-packaging.js';

const RUNTIME = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/outer/node_modules/@modelcontextprotocol/server/dist/ext/skills/loader.mjs',
  'node_modules/example/dist/skills/runtime.js',
  'node_modules/@scope/skills/index.js',
  'node_modules/skills/index.js',
  'node_modules/example/docs/AGENTS.md',
  'node_modules/@scope/example/dist/CLAUDE.md',
  'skills/uk-legislation-guide/SKILL.md',
  'dist/index.js',
];

const AGENT_DOCS = [
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/references/patterns.md',
  'node_modules/@cyanheads/mcp-ts-core/CLAUDE.md',
  'node_modules/@cyanheads/mcp-ts-core/AGENTS.md',
  'node_modules/example/skills/guide/reference.md',
  'node_modules/@scope/example/skills/guide/reference.md',
  'node_modules/outer/node_modules/@scope/example/skills/guide/reference.md',
  'node_modules/outer/node_modules/inner/.claude/settings.json',
  'node_modules/outer/node_modules/inner/AGENTS.md',
  'node_modules/example/.claude/settings.json',
  'node_modules/example/.agents/guide.md',
  'node_modules/example/CLAUDE.md',
  'node_modules/example/docs/SKILL.md',
  'node_modules/example/SKILL.md',
];

const ALL = [...RUNTIME, ...AGENT_DOCS];

describe('AGENT_DOC_ENTRY', () => {
  it('selects package-root agent docs and keeps nested runtime skills modules', () => {
    expect(filterAgentDocEntries(ALL)).toEqual(AGENT_DOCS);
  });

  it('matches the post-bundle linter selector entry for entry', () => {
    expect(CHECK_ENTRY.source).toBe(STRIP_ENTRY.source);
    expect(ALL.filter((entry) => CHECK_ENTRY.test(entry))).toEqual(AGENT_DOCS);
  });
});
