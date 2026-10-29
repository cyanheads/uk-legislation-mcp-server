# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-10-28

Publishes the uk-legislation-guide Agent Skill over MCP as skill://uk-legislation-guide/SKILL.md, moves to mcp-ts-core 0.13.18 (which fixes a per-request HTTP memory leak under Bun in 0.13.16), and trims the .mcpb to runtime files.

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-10-25

Update mcp-ts-core to 0.13.16 and preserve literal text in inline Markdown output.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-10-09

mcp-ts-core 0.13.8 → 0.13.14: numeric strings and null for optional fields are repaired instead of rejected, tool errors carry a request id, HTTP defaults to stateless sessions in source, server.json lists the public hosted endpoint, and its npm HTTP entry now starts the HTTP transport.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-09-26

First published release: six read-only tools over legislation.gov.uk to search UK legislation, read it as current, enacted or dated text, resolve citations, list amendments, and follow the Publication Log.
