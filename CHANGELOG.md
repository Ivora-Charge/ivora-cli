# Changelog

## Unreleased

- `ivora validate [-f ivora.yaml]` checks a project file offline (IVP-1125). The JSON Schema is
  generated from the vendored `/v1` OpenAPI request bodies, and its operationIds are pinned
  against a snapshot. Secrets are references only, placeholders are errors, and the
  `roaming_partners` and `apps` sections are skipped because they need a signed-in admin.
- `ivora export [--project | --location <id>] [-o ivora.yaml]` writes the live project as
  `ivora.yaml` in the schema `ivora validate` checks (IVP-1126), using read-only GET requests of
  the public /v1 API. It covers locations (with tax lines, opening hours and default tariff),
  stations with EVSEs and connectors, tariffs and the project default, connector tariffs,
  ocpi_publishing, webhooks and displays. Resources are keyed by local key
  (`metadata["ivora.key"]` or a generated one), money is a quoted decimal string, and station
  passwords are `{ secret: env:NAME }` references, never values. `roaming_partners` and `apps`
  need a signed-in admin and are not exported; the reason is printed and noted in the header.
- `ivora plan [-f ivora.yaml] [--json]` (IVP-1127) compares the file with the live project through
  GET requests only and prints create, update, delete and no-op per location, tariff, station and
  webhook, with risks, adopt hints (proposals only) and a file-based site power check. Resources
  match on `metadata["ivora.key"]` (stations also on `charger_id`); only a keyed resource missing
  from the file is a delete, and a resource without a key is unmanaged. Read-only: it applies
  nothing and never reads a secret.

## 0.2.0

- `ivora login` signs in through the browser (OAuth authorization code flow with PKCE S256 and a
  127.0.0.1 loopback callback) where the environment advertises it for the CLI (an `ivora_cli`
  client entry and an issuer on the API base origin), and otherwise falls back to
  the API-key prompt. `ivora login --with-key` keeps the key path for CI and scripts.
- OAuth tokens live in the OS keychain only, refresh silently, and `ivora logout` revokes them
  server-side. `ivora whoami` and `ivora profiles list` show the auth type.
- README (IVP-1034): published on npm; install with `npm install -g @ivora/cli` or `npx @ivora/cli`;
  Node.js >= 22.12; keys and tokens in the OS keychain only (macOS Keychain, Linux Secret Service via
  `secret-tool`; `IVORA_API_KEY` elsewhere); Troubleshooting for `command not found: ivora`.
- Production advertises no OAuth today, so production logins use API keys as before (one-line notice).
- Still read-only: no write or charger-control commands.

## 0.1.0

First public release. Every command is read-only: there are no charger-control or write
commands, and `ivora api` calls GET operations only.

- Scaffold (#1): TypeScript build, lint and tests, mock `/v1` server, public-API catalog test,
  CI, and a release dry run with package checks.
- Authentication (#2): `ivora login` (key from stdin, a hidden prompt or `IVORA_API_KEY`, never
  a command-line argument), profiles for test and live environments with live as an explicit
  opt-in, `ivora whoami`, and key storage in the OS keychain (never in the config file).
- Read-only resources (#3): `ivora stations list|get`, `operations list|get`,
  `tariffs list|get|quote|simulate`, `webhooks list|get`, and `ivora api <operationId>` for
  catalog GET operations; table or `--json` output, cursor pagination with `--all`.
- Release: published from CI only, with npm trusted publishing and provenance, from a v* tag on
  main after manual approval.
