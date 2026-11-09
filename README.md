# Ivora CLI

`ivora` is the command-line client for the public Ivora `/v1` API. It is meant for developers
and operators who manage charging stations, run OCPP diagnostics, test webhooks and migrate
charger networks from a terminal or a script.

`@ivora/cli` is published on npm, with the command `ivora`. This is v0.1: read-only and pre-alpha,
so start with a test key (`iv_test_`) before pointing it at a live account.

## Install

```sh
npm install -g @ivora/cli     # install the `ivora` command
npx @ivora/cli --help         # or run it once without installing
ivora --version               # check the installed version
```

Requires Node.js 22.12 or later. To build from source instead, see
[Install from source](#install-from-source).

## Status

**v0.1 (read-only, pre-alpha).** Implemented: `ivora login`, `ivora profiles`, `ivora whoami` and
the read-only resource commands below (stations, operations, tariffs, webhooks, and `ivora api`
for GET operations). Behaviour and output may still change between releases.

Not yet available (planned for later releases; the CLI cannot change anything on your account yet):

- station commands that write: add, connect, decommission
- remote commands: trigger, reset, unlock, start, stop, with confirmations
- `ivora logs tail` (OCPP message log) and `ivora listen` (forward webhook events to a local URL)
- write operations through `ivora api`

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
  keychain only: the macOS Keychain, or on Linux the freedesktop Secret Service through
  `secret-tool` (libsecret). There is no plain-text file fallback. On Windows, or anywhere
  without a keychain, `ivora login` refuses to save the key; set `IVORA_API_KEY` instead and
  commands will use it directly.
- The config file (`~/.config/ivora/config.toml`) holds profile names, environments and key
  references only, never keys.
- Test keys (`iv_test_`) work with test profiles and live keys (`iv_live_`) with live profiles.
  A live profile is never the default: pass `--live` (or `--profile <name>`) every time.

## Read-only resources

```sh
ivora stations list [--name N] [--charger-id ID] [--limit N] [--after CURSOR] [--all]
ivora stations get <station-id>
ivora operations list [--status S] [--kind K] [--actor A] [--station-id ID] [--before CURSOR]
ivora operations get <operation-id>
ivora tariffs list [--include-archived] | get <tariff-id>
ivora tariffs quote <tariff-id> --session session.json     # a read-only price computation
ivora tariffs simulate --tariff tariff.json --session session.json
ivora webhooks list | get <webhook-id>
ivora api                                                   # list the callable operationIds
ivora api locations_read_one_location --path location_id=1
```

- Output is a table by default and JSON with `--json`. List commands show one page and print the
  next cursor on stderr; `--all` follows every page. In `--json` output `next_cursor` is `null`
  once the listing has reached its end.
- With `--json`, results go to stdout as JSON; errors stay plain text on stderr
  (`error: ...`), and the exit code tells scripts what happened.
- Commands use the key's only tenant, or `--tenant <id>` when it reaches several.
- `ivora api <operationId>` calls only GET operations from the built-in catalog and prints JSON.
  Anything that writes or controls a charger is refused in this release.
- Exit codes: 0 ok, 1 API or network error, 2 usage, 4 timeout, 5 authentication. Errors show the
  API's error code and request id.

## Troubleshooting

**`command not found: ivora` after `npm install -g`.** npm's global bin directory is not on
your `PATH`. Add it, for example in `~/.zshrc` or `~/.bashrc`:

```sh
export PATH="$(npm prefix -g)/bin:$PATH"
```

Then open a new terminal. Alternatively, use a Node.js installed with Homebrew or nvm, which
puts global commands on your `PATH` already.

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
