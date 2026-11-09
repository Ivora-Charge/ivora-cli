import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

const root = process.cwd();
const guard = resolve(root, 'scripts/guard-publish.mjs');
const check = resolve(root, 'scripts/check-package.mjs');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

describe('publish guard', () => {
  let repo: string;
  let mainSha: string;
  let sideSha: string;

  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'ivora-guard-'));
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ name: '@ivora/cli', version: '0.1.0' }),
    );
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'main');
    mainSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', mainSha);
    git(repo, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(repo, 'x.txt'), 'x');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'side');
    sideSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');
  });
  after(() => rmSync(repo, { recursive: true, force: true }));

  const good = (): Record<string, string> => ({
    PATH: process.env.PATH ?? '',
    GITHUB_ACTIONS: 'true',
    GITHUB_WORKFLOW_REF: 'Ivora-Charge/ivora-cli/.github/workflows/release.yml@refs/tags/v0.1.0',
    IVORA_RELEASE_PUBLISH: '1',
    GITHUB_REF_TYPE: 'tag',
    GITHUB_REF: 'refs/tags/v0.1.0',
    GITHUB_SHA: mainSha,
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/oidc',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'placeholder',
  });
  const run = (env: Record<string, string>) =>
    spawnSync('node', [guard], { cwd: repo, env, encoding: 'utf8' });

  it('allows the release path: tag on main, matching version, OIDC, no token', () => {
    const r = run(good());
    assert.equal(r.status, 0, r.stderr);
  });
  it('refuses outside GitHub Actions (a developer machine)', () => {
    const r = run({ PATH: process.env.PATH ?? '' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not running in GitHub Actions/);
  });
  it('refuses a non-tag ref', () => {
    const r = run({ ...good(), GITHUB_REF_TYPE: 'branch', GITHUB_REF: 'refs/heads/main' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not a v\* tag/);
  });
  it('refuses a tag whose commit is not on main', () => {
    git(repo, 'checkout', '-q', sideSha);
    try {
      const r = run({ ...good(), GITHUB_SHA: sideSha });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /not on origin\/main/);
    } finally {
      git(repo, 'checkout', '-q', 'main');
    }
  });
  it('refuses a tag that does not equal the package version', () => {
    const r = run({ ...good(), GITHUB_REF: 'refs/tags/v0.2.0' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /tag does not equal v0\.1\.0/);
  });
  it('refuses when no OIDC token is available (no provenance)', () => {
    const env = good();
    delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const r = run(env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no OIDC token/);
  });
  it('refuses when provenance is disabled', () => {
    const r = run({ ...good(), NPM_CONFIG_PROVENANCE: 'false' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /provenance is disabled/);
  });
  it('refuses when an npm token is present', () => {
    const r = run({ ...good(), NODE_AUTH_TOKEN: 'placeholder' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /NODE_AUTH_TOKEN is set/);
  });
  it('refuses another workflow and a missing opt-in', () => {
    const other = run({
      ...good(),
      GITHUB_WORKFLOW_REF: 'Ivora-Charge/ivora-cli/.github/workflows/ci.yml@refs/heads/main',
    });
    assert.match(other.stderr, /not run from .github\/workflows\/release.yml/);
    const env = good();
    delete env.IVORA_RELEASE_PUBLISH;
    assert.match(run(env).stderr, /opt-in/);
  });
});

describe('check-package', () => {
  let dir: string;
  const packJson = (files: string[]) =>
    JSON.stringify([{ files: files.map((path) => ({ path })) }]);
  const okFiles = ['package.json', 'README.md', 'LICENSE', 'dist/bin/ivora.js', 'dist/src/a.js'];

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ivora-pkg-'));
    copyFileSync(resolve(root, 'package.json'), join(dir, 'package.json'));
    copyFileSync(resolve(root, 'package-lock.json'), join(dir, 'package-lock.json'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const run = (files: string[]) => {
    writeFileSync(join(dir, 'pack.json'), packJson(files));
    return spawnSync('node', [check, '--pack-json', 'pack.json'], { cwd: dir, encoding: 'utf8' });
  };

  it('accepts the intended file list', () => {
    const r = run(okFiles);
    assert.equal(r.status, 0, r.stderr);
  });
  it('refuses source maps, .env, fixtures and tests in the tarball', () => {
    for (const bad of [
      'dist/bin/ivora.js.map',
      '.env',
      'test/fixtures/a.json',
      'dist/test/a.js',
      'src/a.ts',
    ]) {
      const r = run([...okFiles, bad]);
      assert.equal(r.status, 1, bad);
      assert.match(r.stderr, /unexpected file/);
    }
  });
  it('refuses a package missing its binary', () => {
    const r = run(okFiles.filter((f) => f !== 'dist/bin/ivora.js'));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing from package/);
  });
  it('refuses a version that is not a plain release', () => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ ...pkg, version: '0.1.0-rc.1' }));
    try {
      assert.match(run(okFiles).stderr, /not a plain release version/);
    } finally {
      copyFileSync(resolve(root, 'package.json'), join(dir, 'package.json'));
    }
  });
  it('refuses a package without provenance', () => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ ...pkg, publishConfig: { access: 'public' } }),
    );
    try {
      assert.match(run(okFiles).stderr, /provenance must be true/);
    } finally {
      copyFileSync(resolve(root, 'package.json'), join(dir, 'package.json'));
    }
  });
});
