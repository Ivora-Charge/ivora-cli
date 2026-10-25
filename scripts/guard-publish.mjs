// prepublishOnly guard: `npm publish` runs only from the release workflow, and only once that
// workflow opts in. The current release workflow is a dry run and never sets the opt-in, so
// publishing is impossible from any machine until the first release is approved.
const env = process.env;
const fromReleaseWorkflow =
  env.GITHUB_ACTIONS === 'true' &&
  /\/\.github\/workflows\/release\.yml@/.test(env.GITHUB_WORKFLOW_REF ?? '') &&
  env.IVORA_RELEASE_PUBLISH === '1';

if (!fromReleaseWorkflow) {
  console.error(
    'npm publish is disabled: @ivora/cli is published only by the release workflow (.github/workflows/release.yml).',
  );
  process.exit(1);
}
