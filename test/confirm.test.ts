import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  confirmAction,
  confirmName,
  needsConfirmation,
  type Prompter,
} from '../src/lib/confirm.js';
import { ExitCode } from '../src/lib/output.js';

function prompter(answer: string | undefined): Prompter & { asked: string[] } {
  const asked: string[] = [];
  return {
    interactive: answer !== undefined,
    asked,
    async ask(q: string) {
      asked.push(q);
      return answer ?? '';
    },
  };
}

describe('confirm', () => {
  it('asks only for live writes and dangerous writes', () => {
    assert.equal(needsConfirmation({ environment: 'live', write: false }), false);
    assert.equal(needsConfirmation({ environment: 'test', write: true }), false);
    assert.equal(needsConfirmation({ environment: 'live', write: true }), true);
    assert.equal(needsConfirmation({ environment: 'test', write: true, dangerous: true }), true);
  });

  it('shows the environment tag and accepts y', async () => {
    const p = prompter('y');
    await confirmAction(p, {
      environment: 'live',
      write: true,
      summary: 'Reset station st_1',
      project: 'Demo',
    });
    assert.match(p.asked[0]!, /^\[LIVE\] Demo Reset station st_1/);
  });

  it('refuses on no, and non-interactively without --yes', async () => {
    await assert.rejects(
      confirmAction(prompter('n'), { environment: 'live', write: true, summary: 'x' }),
      {
        exitCode: ExitCode.ConfirmRefused,
      },
    );
    await assert.rejects(
      confirmAction(prompter(undefined), { environment: 'live', write: true, summary: 'x' }),
      {
        exitCode: ExitCode.ConfirmRefused,
      },
    );
    await confirmAction(prompter(undefined), {
      environment: 'live',
      write: true,
      summary: 'x',
      yes: true,
    });
  });

  it('type-the-name confirmation', async () => {
    const req = { environment: 'test' as const, expected: 'Depot 1', what: 'decommissioning' };
    assert.equal(await confirmName(prompter('Depot 1'), req), 'Depot 1');
    await assert.rejects(confirmName(prompter('Depot'), req), {
      exitCode: ExitCode.ConfirmRefused,
    });
    await assert.rejects(confirmName(prompter(undefined), req), {
      exitCode: ExitCode.ConfirmRefused,
    });
    assert.equal(
      await confirmName(prompter(undefined), { ...req, confirmName: 'Depot 1' }),
      'Depot 1',
    );
  });
});
