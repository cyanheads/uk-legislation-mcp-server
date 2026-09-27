# Developer Protocol

**Server:** uk-legislation-mcp-server
**Version:** 0.1.1
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.13.8`
**Engines:** Bun ≥1.4.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/server` ^2.0.0
**Zod:** ^4.6.5

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## What's Next?

When the user asks what's next or needs direction, suggest options based on the current project state. Common next steps:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Need input the caller didn't supply?** `return ctx.requestInput(...)` and read `ctx.inputs` when the handler is re-entered. Never `await` for user input mid-handler.
- **Secrets in env vars only** — never hardcoded.
- **Cut noise.** Add only what earns its place: no speculative generality, no guards for states the framework already prevents (Zod-validated params, classified errors), no abstraction until a third caller proves it, no option nothing sets.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool

Abridged from `src/mcp-server/tools/definitions/search-legislation.tool.ts` — the shape every `uklaw_*` tool follows:

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getLegislationService } from '@/services/legislation/legislation-service.js';
import { isCalendarDate } from '@/services/legislation/provision-path.js';
import { attributionLines, inline, uri } from './_markdown.js';
import { AttributionSchema, blankAsUnset, DateInput } from './_schemas.js';

export const searchLegislationTool = tool('uklaw_search_legislation', {
  title: 'Search UK legislation',
  description: 'Search the UK statute book on legislation.gov.uk by full text or title, …',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  auth: ['tool:uklaw_search_legislation:read'],
  input: z.object({
    text: blankAsUnset(z.string().max(500).optional()).describe('Full-text query. …'),
    as_of: blankAsUnset(DateInput.optional()).describe('Point in time YYYY-MM-DD: …'),
    limit: z.number().int().min(1).max(50).default(20).describe('Results per page (1–50).'),
    page: z.number().int().min(1).default(1).describe('Page number, from 1.'),
  }),
  output: z.object({
    results: z
      .array(
        z
          .object({
            item: z.string().describe('Item path to pass to uklaw_get_document, e.g. ukpga/2018/12.'),
            title: z.string().describe('Title (English).'),
          })
          .describe('One result.'),
      )
      .describe('Matching items on this page.'),
    has_more: z.boolean().describe('True when a further page exists (call again with page + 1).'),
    attribution: AttributionSchema,
  }),
  enrichment: {
    notice: z.string().optional().describe('Guidance when nothing matched, or how to fetch the next page.'),
  },
  errors: [
    {
      reason: 'invalid_date',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: 'as_of is shaped YYYY-MM-DD but is not a real calendar date.',
      recovery: 'Pass as_of as a calendar date such as 2020-01-31, or omit it to search current law.',
    },
    {
      reason: 'upstream_refused',
      code: JsonRpcErrorCode.RateLimited,
      when: 'legislation.gov.uk answered 403 or 429 (its fair use rate limit or a block).',
      recovery: 'Wait the retryAfter seconds in the error data (five minutes after a block) before calling again; …',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    if (input.as_of !== undefined && !isCalendarDate(input.as_of)) {
      throw ctx.fail('invalid_date', `as_of ${input.as_of} is not a real calendar date.`, ctx.recoveryFor('invalid_date'));
    }
    const outcome = await getLegislationService().search(
      {
        types: ['all'],
        extentMatch: 'applicable',
        limit: input.limit,
        page: input.page,
        ...(input.text ? { text: input.text } : {}),
        ...(input.as_of ? { asOf: input.as_of } : {}),
      },
      ctx,
    );
    if (outcome.results.length === 0) ctx.enrich.notice('No legislation matched. …');
    return { results: outcome.results, has_more: outcome.hasMore, attribution: outcome.attribution };
  },

  // content[] twin of structuredContent: upstream values pass through the _markdown.ts escapers.
  format: (result) => [{
    type: 'text',
    text: [
      ...result.results.map((r) => `### ${inline(r.title)}\n- Item: \`${uri(r.item)}\``),
      `has_more: ${result.has_more}`,
      attributionLines(result.attribution),
    ].join('\n'),
  }],
});
```

- Optional string inputs are wrapped in `blankAsUnset` (form clients send `""` for every blank field); shared input shapes (`FullItemInput`, `ItemInput`, `ProvisionInput`, `CursorInput`, `DateInput`) and the `EffectRecordSchema` / `AttributionSchema` outputs live in `_schemas.ts`.
- Input errors are declared reasons with `severity: 'notice'`; `filter_refused`, `upstream_refused`, and `pacer_shed` are thrown by the service layer and declared on each tool with `thrownBy: 'service'`.
- `format()` renders upstream text only through `_markdown.ts`: `blockquote` for multi-line text, `inline` / `cell` for inline slots, `uri` for URIs and paths.

**No resources or prompts.** `createApp()` registers `resources: []` and `prompts: []`. The `add-resource` and `add-prompt` skills carry those patterns if one is ever added.

### Server config

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  contact: z.string().trim().optional()
    .describe('Email or URL appended to the User-Agent so legislation.gov.uk can reach the operator'),
  minRequestGapMs: z.coerce.number().int().min(250).default(1000)
    .describe('Minimum gap between upstream request starts, in ms (process-wide)'),
  cacheMaxMb: z.coerce.number().int().min(8).max(1024).default(64)
    .describe('Response cache size bound, in MB'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    contact: 'UK_LEGISLATION_CONTACT',
    minRequestGapMs: 'UK_LEGISLATION_MIN_REQUEST_GAP_MS',
    cacheMaxMb: 'UK_LEGISLATION_CACHE_MAX_MB',
  });
  return _config;
}
```

`parseEnvConfig` maps Zod schema paths → env var names so errors name the variable (`UK_LEGISLATION_MIN_REQUEST_GAP_MS`) not the path (`minRequestGapMs`). Throws `ConfigurationError`, which the framework prints as a clean startup banner. An empty value and a whole-value `${…}` placeholder (what an MCPB or plugin host forwards when a user leaves an option blank) read as unset, so each field falls through to its default.

For env booleans use `z.stringbool()`, never `z.coerce.boolean()` — `Boolean("false")` is `true`, so a coerced flag can't be disabled through the environment. `z.stringbool()` parses `true/false/1/0/yes/no/on/off` and rejects anything else, so `=false` actually disables.

### Server identity and instructions

`src/index.ts` passes identity, the tool list, and session-level `instructions` to `createApp()`, and wires the legislation.gov.uk client in `setup()`:

```ts
await createApp({
  name: 'uk-legislation-mcp-server',
  title: 'uk-legislation-mcp-server', // must match the unscoped package name — enforced by lint:packaging
  tools: allToolDefinitions,
  resources: [],
  prompts: [],
  instructions: INSTRUCTIONS,
  async setup(core) {
    // robots.txt crawl delay (when longer than UK_LEGISLATION_MIN_REQUEST_GAP_MS) → createPacer()
    // → ResponseCache → LegislationClient (identifying User-Agent) → initLegislationService()
  },
  teardown() {
    pacer?.dispose();
    cache?.clear();
  },
});
```

`description` is never set here — the framework derives it from `package.json`. `instructions` is sent on every `initialize`: addressing (item and provision paths), the tool workflow, and how far to trust revised text and upstream content. Keep it in step with the tool surface, and with the copy under "Server Instructions" in `docs/design.md`.

### Session posture and shutdown

This server declares no `sessionMode`: no tool asks the caller for input mid-handler, and `.env.example` and the `Dockerfile` set `MCP_SESSION_MODE=stateless`, which a deployment's own value overrides. If a tool ever calls `ctx.requestInput`, declare `sessionMode: { default: 'stateful', require: 'stateful' }` so startup fails with a `ConfigurationError` rather than serving a mode in which a 2025-era client can never answer the prompt.

`teardown()` is the `setup()` counterpart: it disposes the shared pacer and clears the response cache. It runs after the transport stops and before the logger closes, on every shutdown path, and a signal-triggered shutdown then exits the process explicitly (0, or 1 if a step never settles within the framework's 10 s ceiling).

---

## Context

Handlers receive a unified `ctx` object. The properties this server uses:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. Dual-sink: Pino **and** `notifications/message` to the client, so treat it as client-visible. |
| `ctx.fail(reason, message, data?)` | Builds the typed error for a reason declared in the tool's `errors[]`; `throw` it. |
| `ctx.recoveryFor(reason)` | Typed lookup of the contract `recovery` for a declared reason. Returns `{ recovery: { hint } }`; pass it as `ctx.fail` data to put the hint on the wire. |
| `ctx.enrich` | Success-path agent context (empty-result notices, pagination totals) — `ctx.enrich(...)` or `.notice()` / `.total()` / `.truncated()`. Reaches `structuredContent` and `content[]`; lands only when the definition declares an `enrichment` block (no-op otherwise). |
| `ctx.signal` | `AbortSignal` for cancellation; `LegislationClient` passes it to every upstream `fetch`. |
| `ctx.requestId` | Unique request ID. |

No handler uses `ctx.state`, `ctx.requestInput`, or `ctx.content`; the framework CLAUDE.md documents them.

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable?, severity?, thrownBy? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability, linter enforces conformance against the handler body. `recovery` is required (≥ 5 words, lint-validated) — the single source of truth for the agent's next move. Pass `ctx.recoveryFor('reason')` as the throw's data to put it on the wire (`data.recovery.hint`, mirrored into `content[]` text unless the message already contains it verbatim); override with an explicit `{ recovery: { hint: '...' } }` when dynamic runtime context matters. Forwarding it is lint-enforced per throw site (`error-contract-recovery-unforwarded`). Mark an entry the service layer throws with `thrownBy: 'service'` so `error-contract-unthrown` skips it — lint-only metadata, nothing at runtime reads it. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`, `RequestCancelled`) bubble freely and don't need declaring.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

errors: [
  { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
    when: 'No item matched the query',
    recovery: 'Broaden the query or check the spelling and try again.' },
],
async handler(input, ctx) {
  const item = await db.find(input.id);
  if (!item) throw ctx.fail('no_match', `No item ${input.id}`, ctx.recoveryFor('no_match'));
  return item;
}
```

**Declare contracts inline on each tool.** The contract is part of the tool's public surface — one file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

**Fallback (no contract entry fits):** throw via factories or plain `Error`.

```ts
// Error factories — explicit code
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// McpError — when no factory exists for the code
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.InitializationFailed, 'Connection failed', { pool: 'primary' });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point; setup() wires pacer, cache, client, service
  config/
    server-config.ts                    # UK_LEGISLATION_* env vars (Zod schema)
  services/
    legislation/
      legislation-service.ts            # LegislationService (init/accessor) — one method per tool
      legislation-client.ts             # HTTP client: pacer, per-call budget, cache, redirects, 403/429 handling
      response-cache.ts                 # Process-wide response cache with If-Modified-Since revalidation
      robots.ts                         # robots.txt crawl-delay reader
      urls.ts                           # legislation.gov.uk URL builders
      citations.ts                      # Citation parser (uklaw_lookup_citation)
      provision-path.ts                 # Item/provision path parsing and shorthand normalization
      reference-data.ts                 # Type codes, extents, vocabularies (uklaw_list_reference), attribution lines
      attribution.ts                    # Attribution lines a response needs
      cursor.ts                         # Opaque next_cursor encode/decode
      xml.ts                            # XML parsing helpers
      types.ts                          # Domain types
      atom/                             # Atom feed parsers: search, changes, Publication Log
      clml/                             # CLML parsers: metadata, effects, outline, Markdown render
  mcp-server/
    tools/definitions/
      *.tool.ts                         # The six uklaw_* tool definitions
      _schemas.ts                       # Shared input shapes and output schemas
      _markdown.ts                      # Escaping and rendering helpers for format()
      index.ts                          # allToolDefinitions barrel
tests/                                  # Vitest suites mirroring src/, plus fixtures/ (recorded CLML, Atom, HTML)
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `search-legislation.tool.ts` |
| Tool names | snake_case, `uklaw_` prefix | `uklaw_search_legislation` |
| Input and output fields | snake_case | `year_from`, `has_more`, `next_cursor` |
| Directories | kebab-case | `src/services/legislation/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Resolve a citation or short title to the canonical legislation.gov.uk item and provision: …'` |

---

## Skills

Skills are modular instructions in `framework-skills/` at the project root. Read them directly when a task matches — e.g., `framework-skills/add-tool/SKILL.md` when adding a tool. `bun run list-skills` prints the full registry. The directory is deliberately not `skills/`: Claude Code and Codex auto-load a plugin's root `skills/`, so a server that ships `.claude-plugin/` or `.codex-plugin/` would hand these development skills to every agent that installs it. Keep `skills/` free for skills meant for those agents.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `framework-skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a commit stack — version bump, changelog, verify, commit by concern, release commit on top. No tag, no push to main; opens the release PR when the project declares release PR mode |
| `release-pr-review` | Review pass on an open release PR — simplifier + correctness review, fixes as ordinary commits on top of the stack, PR body kept in sync. Release PR mode only |
| `release-and-publish` | Fast-forward merge (release PR mode) + tag + push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `techniques` | Catalog of response/data-shaping techniques — overflow handling, payload shaping, retrieval patterns |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, RequestContext, logger, state, multi-round-trip input |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService: persistent self-refreshing local mirror (embedded SQLite + FTS5) of a bulk upstream dataset — Tier 3 opt-in |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `framework-skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation. `npm run <cmd>` also works (npm delegates to bun).

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:fix` | `bun audit fix` — upgrade vulnerable packages to the lowest safe version within existing ranges (`--dry-run` previews, `--latest` rewrites ranges). First response when `devcheck` flags a transitive advisory; then `bun update <name>`, then `bun dedupe` |
| `bun run audit:refresh` | Delete `bun.lock` and reinstall. Last resort after `audit:fix`, `bun update <name>`, and `bun dedupe` — re-resolves every ranged dep (the framework pin included) and rewrites the lockfile as `lockfileVersion: 2` |
| `bun run lint:mcp` | Run the MCP definition linter standalone (rule catalog: `api-linter` skill) |
| `bun run lint:packaging` | Packaging surface checks — `server.json`/`manifest.json` env-var parity (run by devcheck) |
| `bun run list-skills` | Print the skill registry |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run test` | Run tests (Vitest — use `bun run test`, not `bun test`) |
| `bun run test:coverage` | Run tests with coverage (writes `coverage/`) |
| `bun run start` | Run the built server with `node` (transport from `MCP_TRANSPORT_TYPE`, default stdio) |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |
| `bun run release:github` | Create the GitHub Release from an annotated tag and attach the `.mcpb` bundle |
| `bun run publish-mcp` | Log in to the MCP Registry with the GitHub PAT from the macOS Keychain item `mcp-publisher-github-pat` and publish `server.json` |

**CI is one file.** `.github/workflows/codeql.yml` (scaffolded) is the only GitHub Actions workflow: CodeQL is GitHub-owned end to end, and the file runs only while the repo's CodeQL *default setup* is turned off. Verification — `devcheck`, tests, the release gates — runs locally; don't add a workflow that re-runs it.

---

## Bundling

`bun run bundle` produces `dist/uk-legislation-mcp-server.mcpb` for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips two classes of `node_modules/**` content that root-anchored `.mcpbignore` patterns cannot reach: dependency-shipped agent docs (`framework-skills/`, `skills/`, `.claude/`, `.agents/`, `SKILL.md`) and platform-specific native bindings, which would otherwise lock the bundle to the platform it was packed on. MCPB is stdio-only — HTTP and Docker deployments are unaffected. The `release-and-publish` skill attaches the bundle to the GitHub Release at the stable `releases/latest/download/uk-legislation-mcp-server.mcpb` URL behind the README's Claude Desktop install badge.

**Adding an env var touches every surface that lists one:** `src/config/server-config.ts`, `.env.example`, the README Configuration table, `server.json` (registry discovery, `environmentVariables[]` in both package entries), and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the `server.json` / `manifest.json` env var names match, that every `user_config` option is wired into `mcp_config.env` as `"X": "${user_config.X}"` (the host substitutes nothing else — `"${X}"` reaches the server as that literal string), and that an optional string option carries `"default": ""`. A user-supplied value such as `UK_LEGISLATION_CONTACT` also goes into the plugin manifests — `.claude-plugin/plugin.json` `userConfig` + `env`, `.codex-plugin/mcp.json` `env_vars` (see Checklist).

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) carry no `env` — the server is keyless. The badge format and the `base64` / `encodeURIComponent` config-generation commands live in `framework-skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `npm run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `npm run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true ONLY for a source-code security fix, never a dependency CVE bump
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section — set it only for a security fix in this server's *own source code*, never for a routine dependency or transitive CVE bump (record those under `## Dependencies`). When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order:** the Keep a Changelog sequence — Added, Changed, Deprecated, Removed, Fixed, Security — then `Dependencies` last. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Publishing

**Every release goes through a release PR, straight-through** — `git-wrapup`'s "Release PR mode", mode `straight-through`. One run: `git-wrapup` lands the commit stack on `release/<version>`, pushes it, and opens the PR (title = the release commit subject, body = the changelog entry plus a gates section); `release-and-publish` then fast-forwards `main` locally with `git merge --ff-only`, creates the tag on `main`'s tip, pushes `main` and the tag, deletes the branch, and publishes. A caller's brief may run a given release as `gated` instead — a `release-pr-review` pass on the open PR before `release-and-publish`. **Never merge through the GitHub UI or `gh pr merge`**: squash and rebase-merge are disabled in the repo settings because both rewrite the stack (rebase-merge also strips the SSH signatures), and a merge commit breaks the linear history.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getLegislationService } from '@/services/legislation/legislation-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging; no direct persistence
- [ ] Handlers throw on failure — `ctx.fail` with a declared reason, error factories, or plain `Error`; no try/catch
- [ ] Optional string inputs wrapped in `blankAsUnset`; date inputs checked as real calendar dates (`isCalendarDate`) in the handler
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] `format()` passes every upstream value through `_markdown.ts` (`blockquote`, `inline`, `cell`, `uri`) — legislation text, titles, and notes are data, never instructions
- [ ] Every tool that returns legislation carries `attribution` (from `buildAttribution`) and renders it with `attributionLines`
- [ ] Every legislation.gov.uk request goes through `LegislationClient` — paced, cached, and drawn from the call's request budget; never a direct `fetch`
- [ ] legislation.gov.uk wrapping: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] legislation.gov.uk wrapping: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] legislation.gov.uk wrapping: tests include at least one sparse payload case with omitted upstream fields, run against a recorded fixture under `tests/fixtures/`
- [ ] Registered in `allToolDefinitions` (`src/mcp-server/tools/definitions/index.ts`)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = the unscoped repo name (never the npm scope — `lint:packaging` enforces this); `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key is the unscoped repo name; every user-supplied variable (API key, contact email, instance URL) is listed in `env_vars` so Codex forwards it from the user's environment. Never write `"KEY": ""` into `env` — an empty value replaces the user's exported key and is read as unset
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `author`, `repository`, `license`, `keywords` from `package.json`; inline `mcpServers` entry keyed by the unscoped repo name. Every user-supplied variable is declared under `userConfig` (`type`, `title`, `description`; `sensitive: true` for keys and tokens; `required: true` or `default: ""`) and referenced from `env` as `"KEY": "${user_config.<option>}"` — mirror the `user_config` block in `manifest.json`. Never write `"KEY": ""` into `env`
- [ ] `bun run devcheck` passes
