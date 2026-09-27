<div align="center">
  <h1>@cyanheads/uk-legislation-mcp-server</h1>
  <p><b>Search and read UK legislation at any date, resolve citations, list amendments, track changes via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/uk-legislation-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/uk-legislation-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/uk-legislation-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/uk-legislation-mcp-server/releases/latest/download/uk-legislation-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=uk-legislation-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvdWstbGVnaXNsYXRpb24tbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22uk-legislation-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fuk-legislation-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

The National Archives publishes the UK statute book on [legislation.gov.uk](https://www.legislation.gov.uk/): primary, secondary, and EU-origin legislation for the UK, England, Scotland, Wales, and Northern Ireland. This server resolves citations and searches the statute book by text or title. It reads any provision as it stands now, as enacted or made, or as it stood on a date; lists the amendments made to or by an item; and follows what legislation.gov.uk publishes day to day. The API needs no key or account. The server runs as a stdio process or a local Streamable HTTP server.

### Tools

| Tool | Description |
|:---|:---|
| `uklaw_search_legislation` | Search by full text or title, or list by type and year, filtered by extent and point in time |
| `uklaw_get_document` | Read an item or provision as revised, as enacted or made, or on a date, with its editorial status and unapplied effects |
| `uklaw_get_amendments` | List the effects (amendments, repeals, commencements, modifications) recorded against an item or made by it |
| `uklaw_track_changes` | Read the legislation.gov.uk Publication Log for a window of up to 31 days |
| `uklaw_lookup_citation` | Resolve a citation, short title, or legislation.gov.uk URI to the canonical item and provision |
| `uklaw_list_reference` | Decode type codes, extents, version keywords, annotation letters, citation forms, and other vocabulary, offline |

## Capability reference

### `uklaw_search_legislation` <sub>tool</sub>

- `text` (full text: AND/OR, "quoted phrases", stemming) and/or `title` (every word must occur), or neither to list by type and year; `limit` 1–50 (default 20) with `page`
- Filters: `types` (codes such as `ukpga`, `uksi`, `eur`, or the groups `all`, `primary`, `secondary`, `eu-origin`, `draft`; default `all`, which excludes drafts), `year` or `year_from` / `year_to` (1267–2100), `extent` (`england`, `wales`, `scotland`, `ni`) with `extent_match` (`applicable` or `exact`), and `as_of` (`YYYY-MM-DD`); `extent` and `as_of` cannot be combined
- Each result carries the `item` path to pass to `uklaw_get_document`; `has_more` flags another page, and title searches and listings add `facets` (type counts and the newest 25 years)

---

### `uklaw_get_document` <sub>tool</sub>

- `item` is a full path (`ukpga/2018/12`, `uksi/2019/419`, `eur/2016/679`, regnal `ukpga/Eliz2/3-4/19`) or a legislation.gov.uk URI; `provision` a path (`section/45/2/f`, `schedule/2/paragraph/3`) or shorthand (`s. 45(2)(f)`, `Sch. 2 para. 3`); `version` `current` (default), `enacted` (or `made`, `adopted`, `created`), or a `YYYY-MM-DD` date; `language` `en` or `cy`
- `kind` is `full` (Markdown `text` with its `annotations`), `outline` (provision paths to read next, 100 per call from `outline_offset`), or `pdf_only` (`links.pdf`); text over 20,000 characters, or an item with more than 25 leaf provisions, comes back as an outline (a provision with no smaller provisions to list is returned whole up to 40,000 characters and cut past that, with a notice linking the full text), and `match_text` lists an item's provisions that contain a term
- `editorial` (`document_status`, `outstanding_effects`, `caveat`) and `unapplied_effects` (the first 20, at item or provision level) show how far the revised text can be relied on; `version.available` lists the versions to pass as `version`

---

### `uklaw_get_amendments` <sub>tool</sub>

- `item` full or partial (`uksi`, `ukpga/2018`); `direction` `affected` (default: changes made to it) or `affecting` (changes it makes); filters `counterpart` (the other item, full or partial), `status` (`all`, `unapplied`, `applied`; default `all`), and `provision` (needs a full item; scans up to 1,500 effects per call)
- `limit` 1–100 (default 20), continued with `next_cursor`; each effect names both sides with their provisions, `in_force` dates, `applied` / `outstanding`, and `notes`; `total` counts effects before the provision filter, and `scan` reports its coverage
- Pre-1963 Acts are queried by calendar year (`ukpga/1925/20`) and drafts are not indexed: both fail as `regnal_item` / `draft_item`, with the route to take instead

---

### `uklaw_track_changes` <sub>tool</sub>

- `start_date` (required) and `end_date` (defaults to `start_date`), a window of at most 31 days; filters `content_type` (`legislation`, `changes`, `draft`, `associated-documents`), `direction` (with `changes` only), `category` (`primary`, `secondary`, `eu-origin`; with `legislation` or `associated-documents` only), `item`, `new_only`, and `event` (`published`, `withdrawn`)
- `limit` 1–80 (default 40), continued with `next_cursor`; `mode` is `day_walk` (days newest first, up to 4 upstream requests per call) or `item_log` (a full `item` path reads that item's own log and reports `read_back_to`)
- A `changes` event carries no effect detail: `uklaw_get_amendments` on its item has it

---

### `uklaw_lookup_citation` <sub>tool</sub>

- One `citation` of up to 300 characters: a numbered citation, a short title, or a legislation.gov.uk URI, optionally with a provision (forms below)
- Returns the canonical `item` path, plus `provision_found` for a cited provision, checked against the current version; a miss or an ambiguous title is `found: false` with `guidance` or up to 20 `candidates`, not an error

| Form | Examples | Resolves to |
|:---|:---|:---|
| UK Act by chapter | `2018 c. 12` | `ukpga/2018/12`; before 1963 the calendar year is searched and the regnal candidates returned |
| Act of the Northern Ireland Assembly | `2016 c. 5 (N.I.)` | `nia/2016/5` |
| UK Statutory Instrument | `S.I. 2019/419`, `SI 2019 No. 419`, `S.I. 2002/808 (W. 89)` | `uksi/2019/419`; alternative series numbers are ignored, and Welsh and NI SIs canonicalize to `wsi` / `nisi` |
| Scottish Statutory Instrument | `S.S.I. 2020/123` | `ssi/2020/123` |
| Northern Ireland Statutory Rule | `S.R. 2020/12`, `S.R. 2020 No. 12` | `nisr/2020/12` |
| Scottish and Welsh Acts and Measures | `2020 asp 13`, `asp 2020/13`, `2016 anaw 1`, `2021 asc 1`, `2010 nawm 1` | `asp/2020/13`, `anaw/2016/1`, `asc/2021/1`, `mwa/2010/1` |
| EU-origin legislation | `Regulation (EU) 2016/679`, `Regulation (EC) No 1535/2003`, `Directive 95/46/EC`, `Decision (EU) 2019/419`; the issuing body may lead (`Council Regulation (EC) No 1/2003`) | `eur/2016/679`, `eur/2003/1535` (pre-2015 numbering is number/year), `eudr/1995/46`, `eudn/2019/419` |
| Defined name | `UK GDPR` | `eur/2016/679` |
| legislation.gov.uk URI | `https://www.legislation.gov.uk/ukpga/2018/12/section/45` | Split into item, provision, and version |
| Short title | `Data Protection Act 2018`, `Human Rights Act 1998 (c. 42)` | Resolved by title and year; a trailing chapter resolves the Act by number when the title does not |

Any form can end with a provision (`s. 45(2)(f)`, `section 45`, `reg. 5`, `art. 28(3)`, `r. 7`, `r. 3.4`, `Sch. 2 para. 3`, `Pt 3`) or start with one followed by "of" or "of the": `section 45 of the Data Protection Act 2018`. `uklaw_list_reference` topic `citation_formats` returns the same list.

---

### `uklaw_list_reference` <sub>tool</sub>

- `topic`: `types`, `type_groups`, `extents`, `versions`, `document_status`, `annotation_types`, `effects`, `provision_paths`, `citation_formats`, `publication_log`, `coverage`, or `attribution`
- Offline, with no request to legislation.gov.uk; each entry is a `key`, `label`, `description`, and optional `details`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

legislation.gov.uk-specific:

- Keyless client for legislation.gov.uk's API: CLML XML for documents, Atom feeds for search, effects, and the Publication Log
- Follows legislation.gov.uk's fair use policy: an identifying User-Agent on every request, one process-wide queue that spaces request starts (1 second apart by default) and adopts a longer robots.txt crawl delay set for this server, up to 60 seconds, and at most 4 upstream requests per tool call within a 45-second deadline
- Process-wide response cache, with lifetimes taken from upstream `max-age` (capped at one hour) and `If-Modified-Since` revalidation
- Citation shorthand (`s. 45(2)(f)`, `reg. 5`, `Sch. 2 para. 3`) normalized to provision paths; pre-1963 regnal paths and Welsh-language text (`language: "cy"`) supported
- PDF-only items are linked, never fetched, as legislation.gov.uk's robots.txt requires

Agent-friendly output:

- Every document read returns its editorial status with the text (`editorial.document_status`, `caveat`, `outstanding_effects`) and the `unapplied_effects` touching it, so the caller can tell when the revised text is behind on amendments
- `uklaw_lookup_citation` returns a miss as `found: false` with `guidance` or `candidates`, not as an error
- Each tool's typed error reasons (`provision_not_found`, `version_not_found`, `regnal_item`, …) carry a recovery hint naming the next call
- Every response that returns legislation includes `attribution`, the licence lines its content needs (see [License](#license))
- Upstream text is treated as data: legislation text, annotations, and effect notes are blockquoted in `content[]`, inline values are escaped, and URIs are percent-encoded

## Getting started

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "uk-legislation-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/uk-legislation-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "uk-legislation-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/uk-legislation-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "uk-legislation-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/uk-legislation-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key or account is needed. The legislation.gov.uk [fair use policy](https://www.legislation.gov.uk/fair-use-policy) asks non-browser clients to identify themselves, so set `UK_LEGISLATION_CONTACT` to an email or URL when you run a shared deployment.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/uk-legislation-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd uk-legislation-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set UK_LEGISLATION_CONTACT as needed
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `UK_LEGISLATION_CONTACT` | Email or URL appended to the User-Agent so legislation.gov.uk can reach the operator. Set it on shared deployments. | none |
| `UK_LEGISLATION_MIN_REQUEST_GAP_MS` | Minimum gap between upstream request starts, in ms, across the process; `250` at least. A longer robots.txt crawl delay for this server's User-Agent raises it. Replicas sharing one User-Agent divide the fair use limit, so use at least 250 ms × replica count. | `1000` |
| `UK_LEGISLATION_CACHE_MAX_MB` | Response cache size bound, in MB (`8`–`1024`). | `64` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_HTTP_HOST` | HTTP server host. | `127.0.0.1` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. `.env.example` and the Docker image set `stateless`. | `auto` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point: registers the six tools; `setup()` reads robots.txt and builds the pacer, response cache, client, and service. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools/definitions` | Tool definitions (`*.tool.ts`), plus the shared input/output schemas and Markdown rendering helpers. |
| `src/services/legislation` | legislation.gov.uk service layer: HTTP client, response cache, citation and provision-path parsing, CLML and Atom parsers, reference data, attribution. |
| `tests/` | Unit tests mirroring `src/`, run against recorded CLML and Atom fixtures. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging and `ctx.fail` with a declared reason for expected failures
- Register new tools in `allToolDefinitions` in `src/mcp-server/tools/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.

Legislation content from legislation.gov.uk is © Crown and database right, licensed under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/). EU-origin items also carry a European Union credit (© European Union, 1998-2020, re-used under Commission Decision 2011/833/EU), and pre-1987 statutory instruments contributed to legislation.gov.uk by Westlaw UK carry a Westlaw credit. Every tool that returns legislation lists the lines that apply to its content in `attribution`.
