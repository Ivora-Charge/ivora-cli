# Ivora CLI

`ivora` is the command-line client for the public Ivora `/v1` API. It is meant for developers
and operators who manage charging stations, run OCPP diagnostics, test webhooks and migrate
charger networks from a terminal or a script.

The package will be published on npm as `@ivora/cli`, with the command `ivora`.

## Status

**Pre-alpha scaffold.** This repository holds the build, test and CI setup and the shared
library stubs (HTTP client, output, profiles, secret redaction, confirmations). Implemented so
far: `ivora login`, `ivora profiles` and `ivora whoami`. Nothing has been published to npm. Do not use it against a live
account.

Planned for the first release (v0.1):

- `ivora login` with an API key, profiles for the test and live environments, `ivora whoami`
- station resources: list, show, add, connect, decommission
- remote commands: trigger, reset, unlock, start, stop, with confirmations
- `ivora logs tail` (OCPP message log) and `ivora listen` (forward webhook events to a local URL)
- tariff quotes and simulations, webhook endpoints, and `ivora api` for any public `/v1` path

The CLI only calls the public `/v1` API. It has no staff or admin commands.

## Authentication

```sh
printf '%s' "$KEY" | ivora login          # or type it at the hidden prompt
ivora --live login                          # live is an explicit opt-in
ivora whoami
ivora profiles list | use <name> | remove <name>
```

- Keys are never accepted as command-line arguments. `ivora login` reads one from stdin, a
  hidden prompt or `IVORA_API_KEY`, checks it with `GET /v1/access`, and stores it in the OS
  keychain (macOS Keychain, or `secret-tool` on Linux). If there is no keychain the CLI refuses
  to save the key rather than writing it to disk; use `IVORA_API_KEY` instead.
- The config file (`~/.config/ivora/config.toml`) holds profile names, environments and key
  references only, never keys.
- Test keys (`iv_test_`) work with test profiles and live keys (`iv_live_`) with live profiles.
  A live profile is never the default: pass `--live` (or `--profile <name>`) every time.

## Install from source

Requirements: Node.js 22.12 or later and npm.

```sh
git clone https://github.com/Ivora-Charge/ivora-cli.git
cd ivora-cli
npm ci
npm run build
node dist/bin/ivora.js --help

# optional: put `ivora` on your PATH
npm link
ivora --version
```

The default API endpoint is `https://api.ivoracharge.com`. Set `IVORA_API_BASE` (or
`ivora login --base-url`) to point a test profile at another environment. Live profiles ignore
`IVORA_API_BASE`, so a leftover test URL never receives a live key; a live profile uses the URL
stored with `ivora --live login --base-url` or the default.

## Development

```sh
npm ci          # install the locked dependencies
npm run build   # type-check and compile src/ to dist/
npm test        # unit tests and the mock /v1 server tests (no network)
npm run lint    # ESLint and Prettier checks
npm run format  # apply Prettier
```

Tests use the Node.js built-in test runner (`node:test`) against a local mock of the `/v1`
API in `test/mock-server.ts`. No test talks to a real API.

## Contributing

Issues and pull requests are welcome. Before you open a pull request:

- run `npm run build`, `npm test` and `npm run lint`;
- keep dependencies few, and do not add packages with install scripts;
- never include API keys, station passwords, webhook secrets or customer data in code, tests,
  fixtures or issues. Use obviously fake values in tests.

By contributing you agree that your contribution is licensed under the Apache License 2.0.

## Security

Please do not report security problems in public issues. See [SECURITY.md](SECURITY.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
