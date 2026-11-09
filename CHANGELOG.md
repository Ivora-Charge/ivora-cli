# Changelog

## Unreleased

- `ivora login` signs in through the browser (OAuth authorization code flow with PKCE S256 and a
  127.0.0.1 loopback callback) where the environment advertises it, and otherwise falls back to
  the API-key prompt. `ivora login --with-key` keeps the key path for CI and scripts.
- OAuth tokens live in the OS keychain only, refresh silently, and `ivora logout` revokes them
  server-side. `ivora whoami` and `ivora profiles list` show the auth type.

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
