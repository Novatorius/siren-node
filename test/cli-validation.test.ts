import { describe, expect, it } from 'vitest';
import { BadRequestError } from '../src/errors';
import { fieldProblems } from '../src/cli/validation';
import { runCli } from '../src/cli/run';
import { harness } from './cli-fakes';
import { reply } from './http-fakes';

/*
 * Siren's 400 VALIDATION_FAILED, as phpnomad/rest's ValidationSet and
 * Siren's lib/Validations/Core rules write it: one entry a broken rule, in
 * error.context.failedValidations, each {field, message, type, context}.
 */
const FAILED = {
  error: {
    message: 'Validations failed.',
    code: 'VALIDATION_FAILED',
    context: {
      type: 'VALIDATION_FAILED',
      failedValidations: [
        { field: 'nickname', message: 'nickname is required.', type: 'REQUIRED' },
        { field: 'nickname', message: 'nickname must be text, got no value.', type: 'INVALID_TYPE', context: { requiredType: 'string', maxLength: 191 } },
        { field: 'email', message: 'email must be a valid email address of 254 characters or fewer.', type: 'INVALID_EMAIL', context: { maxLength: 254 } },
        { field: 'status', message: 'status must be one of: active, inactive, pending.', type: 'REQUIRES_ANY', context: { validValues: ['active', 'inactive', 'pending'] } },
      ],
    },
  },
};
const strip = (text: string) => text.replace(/\u001b\[[\d;?]*[A-Za-z]/g, '');
const CREATE = ['collaborators', 'create', '-d', 'email=not-an-email', '-d', 'status=bogus'];

describe('fieldProblems', () => {
  it('gives one row a field, drops the repeated name, lets REQUIRED stand alone, and lists the valid values', () => {
    const error = new BadRequestError('Validations failed.', { code: 'VALIDATION_FAILED', data: FAILED.error.context });
    expect(fieldProblems(error)).toEqual([
      { at: 'nickname', message: 'is required' },
      { at: 'email', message: 'must be a valid email address of 254 characters or fewer' },
      { at: 'status', message: 'must be one of active, inactive, pending' },
    ]);
  });

  it('joins two rules one field broke, and answers nothing for an error with no failures', () => {
    const two = new BadRequestError('Validations failed.', {
      data: { failedValidations: [{ field: 'amount', message: 'amount must be a number from 0 to 1000.', type: 'INVALID' }, { field: 'amount', message: 'The key amount must be numeric.', type: 'REQUIRES_NUMERIC' }] },
    });
    expect(fieldProblems(two)).toEqual([{ at: 'amount', message: 'must be a number from 0 to 1000, and must be numeric' }]);
    expect(fieldProblems(new BadRequestError('Bad.', {}))).toEqual([]);
    expect(fieldProblems(new Error('x'))).toEqual([]);
  });
});

describe('a validation failure on a generated command', () => {
  it('prints one row a field in a terminal, under what was refused and how many', async () => {
    const h = harness([reply(400, FAILED)]);
    h.signedIn();
    expect(await runCli(CREATE, { ...h.io, stderrTty: true, env: { ...h.io.env, TERM: 'xterm-256color' } })).toBe(1);
    expect(strip(h.err())).toBe(
      [
        '✗ Siren refused the new collaborator.',
        '  3 fields need fixing.',
        '  nickname  is required',
        '  email     must be a valid email address of 254 characters or fewer',
        '  status    must be one of active, inactive, pending',
        '› Fix them and run again. siren collaborators create --help lists the fields.',
        '',
      ].join('\n'),
    );
  });

  it('prints one field: message line each through a pipe', async () => {
    const h = harness([reply(400, FAILED)]);
    h.signedIn();
    expect(await h.run(CREATE)).toBe(1);
    expect(h.err().split('\n').slice(1)).toEqual([
      'nickname: is required',
      'email: must be a valid email address of 254 characters or fewer',
      'status: must be one of active, inactive, pending',
      '',
    ]);
    expect(h.err().split('\n')[0]).toBe('siren: Siren refused the new collaborator. 3 fields need fixing. Fix them and run again. siren collaborators create --help lists the fields.');
  });

  it("names the record a change was refused for, and a raw post by its route", async () => {
    const one = { error: { ...FAILED.error, context: { ...FAILED.error.context, failedValidations: [FAILED.error.context.failedValidations[3]] } } };
    const change = harness([reply(400, one)]);
    change.signedIn();
    expect(await change.run(['collaborators', 'update', '4', '-d', 'status=bogus'])).toBe(1);
    expect(change.err()).toContain('siren: Siren refused the change to collaborator 4. 1 field needs fixing. Fix it and run again.');
    const raw = harness([reply(400, one)]);
    raw.signedIn();
    expect(await raw.run(['post', '/collaborators', '-d', 'status=bogus'])).toBe(1);
    expect(raw.err()).toContain('siren: Siren refused POST /collaborators. 1 field needs fixing.');
  });

  it("carries Siren's context through --json untouched, so a script sees which field failed", async () => {
    const h = harness([reply(400, FAILED)]);
    h.signedIn();
    expect(await h.run([...CREATE, '--json'])).toBe(1);
    const printed = JSON.parse(h.err()) as { error: Record<string, unknown> };
    expect(printed.error.context).toEqual(FAILED.error.context);
    expect(printed.error.code).toBe('VALIDATION_FAILED');
    expect(h.out()).toBe('');
  });
});

describe('a validation failure on a hand-written command', () => {
  it('uses the same rows, such as on apps answer', async () => {
    const h = harness([reply(400, { error: { message: 'Validations failed.', code: 'VALIDATION_FAILED', context: { type: 'VALIDATION_FAILED', failedValidations: [{ field: 'outcome', message: 'outcome must be one of: applied, declined.', type: 'REQUIRES_ANY', context: { validValues: ['applied', 'declined'] } }] } } })]);
    h.signedIn();
    expect(await h.run(['apps', 'answer', 'apr_0123456789abcdef0123456789abcdef', '--body', '{"outcome":"nope"}'])).toBe(1);
    expect(h.err()).toContain('1 field needs fixing.');
    expect(h.err()).toContain('outcome: must be one of applied, declined');
  });
});
