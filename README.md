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

**v0.1 (read-only, pre-alpha).** Implemented: `ivora login` (browser OAuth or API key), `ivora logout`, `ivora profiles`, `ivora whoami` and
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
ivora login                                 # browser sign-in (OAuth) where the environment offers it
printf '%s' "$KEY" | ivora login --with-key # API key from stdin, a hidden prompt or IVORA_API_KEY
ivora --live login                          # live is an explicit opt-in
ivora whoami                                # shows the auth type (OAuth or API key) and scopes
ivora logout                                # revoke the browser sign-in and clear stored credentials
ivora profiles list | use <name> | remove <name>
```

**Browser sign-in.** `ivora login` reads the environment's OAuth authorization-server metadata
(`/.well-known/oauth-authorization-server` under the API base). If it advertises the authorization
code flow with PKCE (S256) and an `ivora_cli` client entry, and its `issuer` is the API base origin,
the CLI opens your browser, and also prints the URL in case no browser opens. It listens for the
redirect on `127.0.0.1` only, on a random free port at `/callback`, checks the `state` (and `iss`,
when the server sends it), and exchanges the code. A callback with a wrong or missing `state`, or a
wrong `Host`, is answered with an error page and ignored; the CLI keeps waiting for the real one
(up to 5 minutes). **IPv6 loopback (`[::1]`) is refused:** the browser callback always uses
`127.0.0.1`. If the metadata is absent, does not offer PKCE S256 or has no `ivora_cli` entry
(production today), the CLI prints `OAuth not available on this environment; paste an API key` and
asks for an API key as before. Without an OS keychain, browser sign-in stops before opening the
browser; if storing the new tokens fails anyway, the CLI revokes them before exiting.

**API keys.** `ivora login --with-key` is the path for CI and scripts. It reads the key from stdin,
a hidden prompt or `IVORA_API_KEY`, and never contacts the OAuth endpoints. Keys are never accepted
as command-line arguments.

- Keys and OAuth tokens (access and refresh) are stored in the OS keychain only: the macOS Keychain,
  or on Linux the freedesktop Secret Service through `secret-tool` (libsecret). There is no
  plain-text file fallback, and tokens are never written to the config file, put in arguments, logs
  or error messages. On Windows, or anywhere without a keychain, `ivora login` refuses to save
  credentials; set `IVORA_API_KEY` instead and commands will use it directly.
- OAuth access tokens refresh silently before they expire, and once after a `401`. If the refresh
  fails, the CLI asks you to run `ivora login` again.
  Refresh tokens rotate, so two `ivora` processes refreshing the same profile at the same moment
  can trip the server's refresh-token reuse detection, which ends the sign-in and means running
  `ivora login` again. Avoid running many OAuth-profile commands in parallel right at token expiry;
  use an API key (`--with-key`) for parallel scripts.
- `ivora logout` revokes the OAuth tokens on the server and clears the keychain entries. If
  revocation fails, it says so (exit code 1) and still clears them locally. An API key cannot be
  revoked from the CLI: logout only removes it from the keychain.
- OAuth sign-ins are refused (HTTP 403) on imports and migration routes. If a command hits one, the
  CLI says so; use an API key (`ivora login --with-key`) for those.
- `ivora whoami` shows `auth` (`oauth` or `api_key`) and the granted `scopes`.
- The config file (`~/.config/ivora/config.toml`) holds profile names, environments, the auth type,
  the token expiry time and keychain references only, never keys or tokens.
- Test keys (`iv_test_`) work with test profiles and live keys (`iv_live_`) with live profiles.
  A live profile is never the default: pass `--live` (or `--profile <name>`) every time. This is the
  same for browser sign-in and `logout`.

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

## Site file (`ivora.yaml`) validation

```sh
ivora validate [-f ivora.yaml]   # check a project file offline; nothing is sent or changed
ivora validate --schema          # print the JSON Schema (for editors)
ivora plan [-f ivora.yaml]       # diff the file against the live project; read-only, applies nothing
```

`ivora.yaml` describes one project: `locations`, `stations` (with `evses` and `connectors`),
`tariffs` and the project `default_tariff`, `load_groups`, `grid`, `ocpi_publishing`, `webhooks`,
`displays` and `migration`. Each section is a map keyed by a local key you choose (`site-1`,
`cp-01`), and sections refer to each other by those keys. The schema is generated from the request
bodies of the published `/v1` OpenAPI document (vendored in `openapi/`, refreshed with
`node scripts/sync-openapi.mjs`); load groups, grid limits, migration and station passwords are
hand-written.

- Secrets are references, never values: `credentials: {secret: env:NAME}` or `{secret: file:path}`.
  A `file:` secret must be mode 600 and must not be inside a git work tree unless git ignores it.
  The secret file itself is never read.
- Placeholders (`TODO`, `<...>`, empty values) are errors. Prices are quoted decimal strings
  (`price: "0.45"`) and `*_minor` amounts are integers.
- `roaming_partners` and `apps` need a signed-in admin, so they are skipped and the reason is
  printed.
- Exit code 0 means the file is valid and 2 means it is not. Errors go to stderr as
  `file: path: message`, and `--json` gives a machine-readable result.

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
