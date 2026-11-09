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
3. npmjs.com trusted publisher for `@ivora/cli` (package settings > Trusted publisher >
   GitHub Actions): organisation/user `Ivora-Charge`, repository `ivora-cli`, workflow file
   name `release.yml`, environment `npm-publish`.
   For the very first publish, if the package does not exist yet, create the package with the
   owner account per npm's current first-publish procedure, then add the trusted publisher.
4. Optionally, once the first release works, set the package to "Require two-factor
   authentication and disallow tokens".

## Release

1. Merge the release PR to `main` (owner approves).
2. The owner tags the merge commit on main and pushes the tag:
   `git tag v0.1.0 && git push origin v0.1.0` (the tag must equal `package.json` version).
3. The `pack` job runs build, lint, tests, pack and package checks. The `publish` job then waits
   for the `npm-publish` environment approval, re-verifies the tag is on `origin/main`, equals the
   version, passes build/test/`check:package`, and runs `npm publish --provenance`.
4. `scripts/guard-publish.mjs` (prepublishOnly) refuses any publish that is not this path:
   not a `v*` tag, commit not on `origin/main`, wrong version, no OIDC token (no provenance),
   or any npm token in the environment.
