# uk-legislation-mcp-server - Directory Structure

Generated on: 2026-10-09 08:58:23

```text
uk-legislation-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   ├── secret_scanning.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   └── template.md
├── docs/
│   └── design.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── install-otel.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── prune-musl-packages.ts
│   ├── release-github.ts
│   └── tree.ts
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   └── tools/
│   │       └── definitions/
│   │           ├── _markdown.ts
│   │           ├── _schemas.ts
│   │           ├── get-amendments.tool.ts
│   │           ├── get-document.tool.ts
│   │           ├── index.ts
│   │           ├── list-reference.tool.ts
│   │           ├── lookup-citation.tool.ts
│   │           ├── search-legislation.tool.ts
│   │           └── track-changes.tool.ts
│   ├── services/
│   │   └── legislation/
│   │       ├── atom/
│   │       │   ├── changes-feed.ts
│   │       │   ├── common.ts
│   │       │   ├── publication-log.ts
│   │       │   └── search-feed.ts
│   │       ├── clml/
│   │       │   ├── effects.ts
│   │       │   ├── metadata.ts
│   │       │   ├── outline.ts
│   │       │   └── render.ts
│   │       ├── attribution.ts
│   │       ├── citations.ts
│   │       ├── cursor.ts
│   │       ├── legislation-client.ts
│   │       ├── legislation-service.ts
│   │       ├── provision-path.ts
│   │       ├── reference-data.ts
│   │       ├── response-cache.ts
│   │       ├── robots.ts
│   │       ├── types.ts
│   │       ├── urls.ts
│   │       └── xml.ts
│   └── index.ts
├── tests/
│   ├── config/
│   │   └── server-config.test.ts
│   ├── fixtures/
│   │   ├── clml/
│   │   │   ├── anaw-2016-1-section-1-welsh.xml
│   │   │   ├── eur-2016-679-article-28.xml
│   │   │   ├── ukpga-1998-29-section-1.xml
│   │   │   ├── ukpga-2018-12-contents-text-processor.xml
│   │   │   ├── ukpga-2018-12-contents.xml
│   │   │   ├── ukpga-2018-12-section-45-2018-05-24.xml
│   │   │   ├── ukpga-2018-12-section-45-2019-01-01.xml
│   │   │   ├── ukpga-2018-12-section-45-enacted.xml
│   │   │   ├── ukpga-2018-12-section-45.xml
│   │   │   ├── uksi-1984-458-contents-made.xml
│   │   │   ├── uksi-1984-458-made.xml
│   │   │   ├── uksi-1985-2081-contents-made.xml
│   │   │   ├── uksi-1986-1078-regulation-1.xml
│   │   │   ├── uksi-2019-1434-regulation-2-made.xml
│   │   │   ├── uksi-2019-419-contents-2020-12-31.xml
│   │   │   ├── uksi-2019-419-contents.xml
│   │   │   └── uksi-2019-419-regulation-5-2019-03-01.xml
│   │   ├── feeds/
│   │   │   ├── changes-affected-ukpga-1925-20.feed
│   │   │   ├── changes-affected-ukpga-2018-12-affecting-ukpga-2025-18.feed
│   │   │   ├── changes-affected-ukpga-2018-12.feed
│   │   │   ├── changes-affecting-uksi-2026.feed
│   │   │   ├── changes-empty.feed
│   │   │   ├── changes-unapplied-affected-ukpga-2018-12.feed
│   │   │   ├── changes-unapplied-scan-page-1.feed
│   │   │   ├── changes-unapplied-scan-page-2.feed
│   │   │   ├── changes-unapplied-scan-page-3.feed
│   │   │   ├── changes-unapplied-scan-page-4.feed
│   │   │   ├── listing-all.feed
│   │   │   ├── number-eur-2016-679.feed
│   │   │   ├── number-ukpga-1955-19.feed
│   │   │   ├── number-ukpga-2018-12.feed
│   │   │   ├── number-uksi-2002-808.feed
│   │   │   ├── search-bilingual.feed
│   │   │   ├── search-text-processor.feed
│   │   │   ├── search-title-data-protection.feed
│   │   │   ├── search-ukpga-2010-2020-text-processor.feed
│   │   │   ├── search-ukpga-2018-title-data.feed
│   │   │   ├── search-zero-hits.feed
│   │   │   ├── update-2026-09-24-changes-primary-empty.feed
│   │   │   ├── update-2026-09-24-legislation-new.feed
│   │   │   ├── update-2026-09-24-page-2.feed
│   │   │   ├── update-2026-09-24.feed
│   │   │   └── update-changes-affected-ukpga-2018-12.feed
│   │   ├── html/
│   │   │   ├── id-item-303.html.txt
│   │   │   ├── id-title-300.html.txt
│   │   │   ├── id-title-301.html.txt
│   │   │   ├── id-ukpga-1955-19-300.html.txt
│   │   │   ├── not-found.html.txt
│   │   │   ├── redirect-307.html.txt
│   │   │   ├── search-page-beyond-307.html.txt
│   │   │   └── welsh-301.html.txt
│   │   └── robots/
│   │       └── robots.txt
│   ├── fuzz/
│   │   └── tools.fuzz.test.ts
│   ├── helpers/
│   │   └── upstream.ts
│   ├── mcp-server/
│   │   └── tools/
│   │       └── definitions/
│   │           ├── _markdown.test.ts
│   │           ├── get-amendments.tool.test.ts
│   │           ├── get-document.tool.test.ts
│   │           ├── index.test.ts
│   │           ├── list-reference.tool.test.ts
│   │           ├── lookup-citation.tool.test.ts
│   │           ├── search-legislation.tool.test.ts
│   │           └── track-changes.tool.test.ts
│   ├── services/
│   │   └── legislation/
│   │       ├── clml/
│   │       │   ├── effects.test.ts
│   │       │   ├── metadata.test.ts
│   │       │   ├── outline.test.ts
│   │       │   └── render.test.ts
│   │       ├── atom.test.ts
│   │       ├── citations.test.ts
│   │       ├── cursor.test.ts
│   │       ├── legislation-client.test.ts
│   │       ├── legislation-service.test.ts
│   │       ├── provision-path.test.ts
│   │       ├── reference-data.test.ts
│   │       ├── response-cache.test.ts
│   │       ├── robots.test.ts
│   │       ├── urls.test.ts
│   │       └── xml.test.ts
│   ├── setup/
│   │   ├── network-tripwire.test.ts
│   │   └── network-tripwire.ts
│   └── index.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
