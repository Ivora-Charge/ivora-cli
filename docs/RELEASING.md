# Releasing @ivora/cli

Publishing is done only by the `publish` job in `.github/workflows/release.yml`, using npm
trusted publishing (OIDC) with provenance. There is no npm token anywhere; never create one.

## One-time owner setup (before the first publish)

1. GitHub: Settings > Environments > New environment `npm-publish`.
   - Required reviewers: the release owner (Mingcan).
   - Deployment branches and tags: restrict to `main` and the tag pattern `v*`
     (selected branches and tags only).
   - No secrets in this environment.
2. npmjs.com: the `@ivora` scope must be owned by the Ivora organisation with 2FA required.
3. First publish (owner decision; see "Bootstrapping the first publish" below), then the
   npmjs.com trusted publisher for `@ivora/cli` (package settings > Trusted publisher >
   GitHub Actions): organisation/user `Ivora-Charge`, repository `ivora-cli`, workflow file
   name `release.yml`, environment `npm-publish`.
4. Optionally, once the first release works, set the package to "Require two-factor
   authentication and disallow tokens".

## Release

1. Merge the release PR to `main` (owner approves).
2. The owner tags the merge commit on main and pushes the tag:
   `git tag v0.1.0 && git push origin v0.1.0` (the tag must equal `package.json` version).
3. The `pack` job runs build, lint, tests, pack and package checks. The `publish` job then waits
   for the `npm-publish` environment approval, re-verifies the tag is on `origin/main`, equals the
   version and passes build, lint and tests. It then packs the tarball once
   (`npm pack --ignore-scripts --json`), runs `check-package` on that pack, runs the publish
   guard as an explicit step, logs the tarball's sha256 and checks its sha1 against the pack,
   and publishes exactly that file: `npm publish ./ivora-cli-<version>.tgz --provenance
--access public`. The tarball is packed in the publish job itself; the `pack` job's uploaded
   artifact is for inspection only and is not published.
4. `scripts/guard-publish.mjs` (explicit step, and prepublishOnly for directory publishes)
   refuses any publish that is not this path: not a pushed `v*` tag (a manual run is refused),
   commit not on `origin/main`, wrong version, no OIDC token (no provenance), or any npm token
   in the environment. The job itself also only runs for `push` events on `v*` tags.

## Bootstrapping the first publish (owner decision)

npm only lets a trusted publisher be configured for a package that already exists on the
registry. As checked on 2026-11-09:

- <https://docs.npmjs.com/trusted-publishers> describes configuring the trusted publisher from
  the package's settings page, and says a new configuration must complete its first successful
  publish within 2 days or it expires. It needs npm CLI 11.5.1+ and Node 22.14.0+.
- <https://docs.npmjs.com/cli/v11/commands/npm-trust> (`npm trust github ...`) states: "The
  package you're configuring must already exist on the npm registry."
- Neither page documents a pending or pre-registration trusted-publisher flow (as PyPI has).
  Re-check both pages at the time of the first publish; if npm has added one, prefer it.

So `@ivora/cli` must exist before `release.yml` can publish v0.1.0. Options, for the owner to
choose (agents do none of these):

A. Placeholder publish (recommended if no pending flow exists). From the owner's own machine,
logged in to npm with 2FA, in an empty directory with only a minimal `package.json`
(`"name": "@ivora/cli"`, `"version": "0.0.0-placeholder"`, `"license": "Apache-2.0"`,
repository `git+https://github.com/Ivora-Charge/ivora-cli.git`) and a one-line README, run
`npm publish --access public` (the registry tags a package's first version `latest`; the
v0.1.0 publish moves `latest` to 0.1.0). Then
add the trusted publisher, set "Require two-factor authentication and disallow tokens",
push the `v0.1.0` tag within 2 days, and afterwards
`npm deprecate @ivora/cli@0.0.0-placeholder "placeholder, use 0.1.0 or later"`
(unpublishing is also possible within 72 hours, but npm then blocks reusing that version;
deprecation is simpler). This guard is not involved: it runs only from this repository.
B. The owner publishes v0.1.0 from their own machine with 2FA, from a clean checkout of the
tagged main commit. This skips provenance for 0.1.0 (provenance needs supported CI), and
the guard refuses local publishes, so it would need the guard bypassed. Not recommended.
C. npm's pending/initial trusted-publisher flow, if npm offers one at the time (see above).

No npm token is created in any option; the owner's interactive login with 2FA is used once for
option A, and trusted publishing (OIDC) for every release after that.
