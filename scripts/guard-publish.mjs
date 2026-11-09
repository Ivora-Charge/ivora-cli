// prepublishOnly guard: `npm publish` is allowed only from the `publish` job of the release
// workflow, on a v* tag whose commit is on origin/main, with the tag equal to package.json's
// version, with OIDC (trusted publishing, hence provenance) available and with no npm token.
// Everything else, including every local machine, is refused.
// Runs in the current directory; the checks read package.json and git from there.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export function publishRefusals(env, cwd = process.cwd()) {
  const why = [];
  if (env.GITHUB_ACTIONS !== 'true') why.push('not running in GitHub Actions');
  if (!/\/\.github\/workflows\/release\.yml@/.test(env.GITHUB_WORKFLOW_REF ?? ''))
    why.push('not run from .github/workflows/release.yml');
  if (env.IVORA_RELEASE_PUBLISH !== '1') why.push('publish opt-in (IVORA_RELEASE_PUBLISH) not set');
  if (env.GITHUB_REF_TYPE !== 'tag' || !(env.GITHUB_REF ?? '').startsWith('refs/tags/v'))
    why.push('not a v* tag');

  let version = '';
  try {
    version = JSON.parse(readFileSync(`${cwd}/package.json`, 'utf8')).version;
  } catch {
    why.push('cannot read package.json');
  }
  if (`refs/tags/v${version}` !== env.GITHUB_REF) why.push(`tag does not equal v${version}`);

  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
    why.push('no OIDC token available (trusted publishing and provenance need id-token: write)');
  for (const name of ['NODE_AUTH_TOKEN', 'NPM_TOKEN', 'NPM_CONFIG_TOKEN'])
    if (env[name]) why.push(`${name} is set; publishing uses trusted publishing, never a token`);
  if (env.NPM_CONFIG_PROVENANCE === 'false') why.push('provenance is disabled');

  try {
    const git = (...args) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const head = git('rev-parse', 'HEAD').trim();
    if (env.GITHUB_SHA && env.GITHUB_SHA !== head)
      why.push('checked-out commit is not the tagged commit');
    git('merge-base', '--is-ancestor', head, 'origin/main');
  } catch {
    why.push('tagged commit is not on origin/main');
  }
  return why;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const why = publishRefusals(process.env);
  if (why.length > 0) {
    console.error(
      `npm publish refused (published only by the release workflow's publish job):\n${why.map((w) => `  - ${w}`).join('\n')}`,
    );
    process.exit(1);
  }
}
