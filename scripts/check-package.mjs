// Release checks that need no secrets and no network:
// - package.json: public scoped package, Apache-2.0, provenance on, repository matching the
//   GitHub repository (npm requires the match for provenance), no install scripts;
// - package-lock.json: no dependency with install scripts;
// - the packed tarball: only the intended files.
// Usage: node scripts/check-package.mjs [--pack-json <file from `npm pack --json`>]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const errors = [];
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));

if (pkg.name !== '@ivora/cli') errors.push(`name is ${pkg.name}`);
if (pkg.license !== 'Apache-2.0') errors.push('license must be Apache-2.0');
if (pkg.private !== false) errors.push('"private" must be false');
if (pkg.publishConfig?.access !== 'public') errors.push('publishConfig.access must be "public"');
if (pkg.publishConfig?.provenance !== true) errors.push('publishConfig.provenance must be true');
if (!pkg.scripts?.prepublishOnly?.includes('guard-publish'))
  errors.push('prepublishOnly guard missing');
for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
  if (pkg.scripts?.[hook]) errors.push(`package.json must not define a "${hook}" script`);
}

const repo = process.env.GITHUB_REPOSITORY ?? 'Ivora-Charge/ivora-cli';
const expectedRepo = `git+https://github.com/${repo}.git`;
if (pkg.repository?.url !== expectedRepo) {
  errors.push(`repository.url is ${pkg.repository?.url}, expected ${expectedRepo}`);
}

for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (entry.hasInstallScript) errors.push(`dependency with install scripts: ${path}`);
}

const packArg = process.argv.indexOf('--pack-json');
const packJson =
  packArg > 0
    ? readFileSync(process.argv[packArg + 1], 'utf8')
    : execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
        encoding: 'utf8',
      });
const files = JSON.parse(packJson)[0].files.map((f) => f.path);
const allowed = (p) =>
  p === 'package.json' || p === 'README.md' || p === 'LICENSE' || /^dist\/.+\.js$/.test(p);
for (const p of files) {
  if (!allowed(p)) errors.push(`unexpected file in package: ${p}`);
}
for (const required of ['package.json', 'README.md', 'LICENSE', 'dist/bin/ivora.js']) {
  if (!files.includes(required)) errors.push(`missing from package: ${required}`);
}

if (errors.length > 0) {
  console.error(errors.map((e) => `check-package: ${e}`).join('\n'));
  process.exit(1);
}
console.log(`check-package: ok (${files.length} files)`);
