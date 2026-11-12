import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiKeyNotAcceptedError,
  AuthenticationError,
  CodeConflictError,
  ConflictError,
  ErrorCode,
  HoldConflictError,
  isKnownErrorCode,
  MissingScopeError,
  PermissionError,
  POLICY_ERROR_CODES,
  PolicyError,
  SirenError,
  SiteDisconnectedError,
  StoreKeyNotAllowedError,
} from '../src/index';
import { jsonResponse, makeClient } from './helpers';

/*
 * Slice 1 acceptance tests: the error classes and codes the Siren PHP SDK
 * has (src/Exception at 59383e6b) and this SDK lacked.
 *
 * INCOMPLETE MARKER: a test written `it.skip(` belongs to the packet named in
 * its describe block. That packet's implementer turns `it.skip(` into `it(`
 * for its own tests and changes nothing else in this file. Tests written
 * `it(` already pass on the architecture commit and must keep passing.
 *
 * Every mapping test sends a real response through the client's transport,
 * so it asserts on the error a caller catches, not on a helper's answer.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Send one error response through `conversions.list()` and return what it throws. */
async function thrownBy(status: number, body: unknown): Promise<unknown> {
  const ctx = makeClient([jsonResponse(status, body)], { maxRetries: 0 });
  return ctx.client.conversions.list().catch((error: unknown) => error);
}

function err(message: string, code?: string, context?: Record<string, unknown>) {
  return { error: { message, ...(code !== undefined ? { code } : {}), ...(context ? { context } : {}) } };
}

describe('P1: the known-code rule (isKnownErrorCode and the existing 401 and 403 classes)', () => {
  it.skip('isKnownErrorCode knows every ErrorCode value', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(isKnownErrorCode(code)).toBe(true);
    }
  });

  it.skip('isKnownErrorCode refuses a missing, empty, retired or foreign code', () => {
    for (const code of [undefined, null, '', 'hold_limit', 'VALIDATION_FAILED', 'code_403', 'MISSING_SCOPE']) {
      expect(isKnownErrorCode(code)).toBe(false);
    }
  });

  it.skip('a 401 with no code that says the route does not accept API keys is an ApiKeyNotAcceptedError', async () => {
    const error = await thrownBy(401, err('This route Does Not Accept API Keys. Sign in instead.'));
    expect(error).toBeInstanceOf(ApiKeyNotAcceptedError);
    expect((error as SirenError).code).toBe('api_key_not_accepted');
  });

  it.skip('a 401 with an unknown code falls back to the wording', async () => {
    const error = await thrownBy(401, err('This route does not accept API keys.', 'legacy_refusal'));
    expect(error).toBeInstanceOf(ApiKeyNotAcceptedError);
    expect((error as SirenError).code).toBe('legacy_refusal');
  });

  it.skip('a 401 with a known code that is not api_key_not_accepted ignores the wording', async () => {
    const error = await thrownBy(401, err('This route does not accept API keys.', 'plan_required'));
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error).not.toBeInstanceOf(ApiKeyNotAcceptedError);
  });

  it.skip('a 403 with no code that says the token is not authorized for a scope is a MissingScopeError with that scope', async () => {
    const error = await thrownBy(403, err('This token is not authorized for records:programs:read.'));
    expect(error).toBeInstanceOf(MissingScopeError);
    expect((error as MissingScopeError).scope).toBe('records:programs:read');
    expect((error as MissingScopeError).anyOf).toEqual([]);
  });

  it.skip('reads the scope from the message without a trailing colon', async () => {
    const error = await thrownBy(403, err('This token is not authorized for event:'));
    expect((error as MissingScopeError).scope).toBe('event');
  });

  it.skip('prefers the context scope over the message', async () => {
    const error = await thrownBy(
      403,
      err('This token is not authorized for event:sale.', 'missing_scope', { scope: 'event:refund' }),
    );
    expect((error as MissingScopeError).scope).toBe('event:refund');
  });

  it.skip('a 403 with a known code that is not missing_scope ignores the scope wording', async () => {
    const error = await thrownBy(403, err('This token is not authorized for event:sale.', 'plan_required'));
    expect(error).toBeInstanceOf(PermissionError);
    expect(error).not.toBeInstanceOf(MissingScopeError);
  });

  it.skip('a 403 with no code that says the key is bound to one store is a StoreKeyNotAllowedError', async () => {
    const error = await thrownBy(403, err('This API key is BOUND TO ONE STORE, so it cannot read payouts.'));
    expect(error).toBeInstanceOf(StoreKeyNotAllowedError);
  });

  it.skip('a 403 with a known code that is not store_key_not_allowed ignores the store wording', async () => {
    const error = await thrownBy(403, err('This API key is bound to one store.', 'admin_required'));
    expect(error).not.toBeInstanceOf(StoreKeyNotAllowedError);
    expect(error).toBeInstanceOf(PermissionError);
  });
});

describe('P2: SiteDisconnectedError', () => {
  it('names Siren\'s revoked-site message', () => {
    expect(SiteDisconnectedError.MESSAGE).toBe('This site is no longer connected.');
  });

  it.skip('maps a 401 with site_disconnected to SiteDisconnectedError', async () => {
    const error = await thrownBy(401, err('This site is no longer connected.', 'site_disconnected'));
    expect(error).toBeInstanceOf(SiteDisconnectedError);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error).toBeInstanceOf(SirenError);
    const sirenError = error as SiteDisconnectedError;
    expect(sirenError.name).toBe('SiteDisconnectedError');
    expect(sirenError.code).toBe('site_disconnected');
    expect(sirenError.statusCode).toBe(401);
    expect(sirenError.message).toBe('This site is no longer connected.');
  });

  it.skip('maps the code whatever the message says', async () => {
    const error = await thrownBy(401, err('Reconnect the site.', 'site_disconnected'));
    expect(error).toBeInstanceOf(SiteDisconnectedError);
  });

  it.skip('maps a 401 with no code by its wording, in any case', async () => {
    expect(await thrownBy(401, err('This site is no longer connected.'))).toBeInstanceOf(SiteDisconnectedError);
    expect(await thrownBy(401, { error: 'This site is NO LONGER CONNECTED' })).toBeInstanceOf(SiteDisconnectedError);
  });

  it.skip('maps a 401 with an unknown code by its wording', async () => {
    const error = await thrownBy(401, err('This site is no longer connected.', 'legacy_refusal'));
    expect(error).toBeInstanceOf(SiteDisconnectedError);
    expect((error as SirenError).code).toBe('legacy_refusal');
  });

  it.skip('lets a known code other than site_disconnected decide over the wording', async () => {
    const error = await thrownBy(401, err('This site is no longer connected.', 'api_key_not_accepted'));
    expect(error).toBeInstanceOf(ApiKeyNotAcceptedError);
    expect(error).not.toBeInstanceOf(SiteDisconnectedError);
  });

  it.skip('checks the revoked-site wording before the API key wording', async () => {
    const error = await thrownBy(401, err('This site is no longer connected, and this route does not accept API keys.'));
    expect(error).toBeInstanceOf(SiteDisconnectedError);
    expect(error).not.toBeInstanceOf(ApiKeyNotAcceptedError);
  });

  it.skip('leaves any other 401 an AuthenticationError', async () => {
    const error = await thrownBy(401, err('Invalid API key.'));
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error).not.toBeInstanceOf(SiteDisconnectedError);
    expect(error).not.toBeInstanceOf(ApiKeyNotAcceptedError);
  });

  it.skip('answers matches() by the same rule', () => {
    expect(SiteDisconnectedError.matches('Anything.', 'site_disconnected')).toBe(true);
    expect(SiteDisconnectedError.matches('This site is no longer connected.')).toBe(true);
    expect(SiteDisconnectedError.matches('This site is no longer connected.', 'missing_scope')).toBe(false);
    expect(SiteDisconnectedError.matches('Invalid API key.')).toBe(false);
  });
});

describe('P3: PolicyError', () => {
  it('names Siren\'s policy denial message', () => {
    expect(PolicyError.DENIED_MESSAGE).toBe("You don't have permission to do that.");
  });

  it.skip('maps a 403 with each policy code to PolicyError', async () => {
    for (const code of POLICY_ERROR_CODES) {
      const error = await thrownBy(403, err('Refused.', code));
      expect(error, code).toBeInstanceOf(PolicyError);
      expect(error, code).toBeInstanceOf(PermissionError);
      const policyError = error as PolicyError;
      expect(policyError.name).toBe('PolicyError');
      expect(policyError.code).toBe(code);
      expect(policyError.statusCode).toBe(403);
    }
  });

  it.skip('keeps a 403 with a known code outside the policy list a plain PermissionError, whatever the wording', async () => {
    for (const code of ['plan_required', 'admin_required', 'migration_closed', 'email_confirmation_required']) {
      const error = await thrownBy(403, err("You don't have permission to do that. A connected site may not.", code));
      expect(error, code).toBeInstanceOf(PermissionError);
      expect(error, code).not.toBeInstanceOf(PolicyError);
    }
  });

  it.skip('reads the refused field from error.context.param', async () => {
    const error = await thrownBy(403, err('A site may not set status.', 'field_not_allowed', { param: 'status' }));
    expect((error as PolicyError).param).toBe('status');
  });

  it.skip('leaves param undefined when the context names no field', async () => {
    const withoutParam = await thrownBy(403, err('Refused.', 'not_permitted'));
    expect((withoutParam as PolicyError).param).toBeUndefined();
    const numericParam = await thrownBy(403, err('Refused.', 'not_permitted', { param: 7 }));
    expect((numericParam as PolicyError).param).toBeUndefined();
  });

  it.skip('maps a 403 with no code to PolicyError when the context names a refused field', async () => {
    const error = await thrownBy(403, err('Refused.', undefined, { param: 'email' }));
    expect(error).toBeInstanceOf(PolicyError);
    expect((error as PolicyError).param).toBe('email');
  });

  it.skip('maps a 403 with no code by each piece of policy wording, in any case', async () => {
    for (const message of [
      "You don't have permission to do that.",
      "YOU DON'T HAVE PERMISSION TO DO THAT.",
      'A Connected Site may not write mappings of the user type.',
      'That program does not run on this site.',
    ]) {
      expect(await thrownBy(403, err(message)), message).toBeInstanceOf(PolicyError);
    }
  });

  it.skip('maps a 403 with an unknown code by its wording', async () => {
    const error = await thrownBy(403, err('That program does not run on this site.', 'legacy_refusal'));
    expect(error).toBeInstanceOf(PolicyError);
  });

  it.skip('leaves a 403 with no code and other wording a plain PermissionError', async () => {
    for (const message of ['Forbidden.', "You don't have permission to do that. Ask an organization admin."]) {
      const error = await thrownBy(403, err(message));
      expect(error, message).toBeInstanceOf(PermissionError);
      expect(error, message).not.toBeInstanceOf(PolicyError);
    }
  });

  it.skip('checks the scope and store wording before the policy wording', async () => {
    const scope = await thrownBy(403, err('A connected site is not authorized for records:programs:read.'));
    expect(scope).toBeInstanceOf(MissingScopeError);
    expect(scope).not.toBeInstanceOf(PolicyError);
    const store = await thrownBy(403, err('This key is bound to one store, so a connected site may not read payouts.'));
    expect(store).toBeInstanceOf(StoreKeyNotAllowedError);
    expect(store).not.toBeInstanceOf(PolicyError);
  });

  it.skip('answers matches() by the same rule', () => {
    expect(PolicyError.matches('Refused.', undefined, 'report_not_allowed')).toBe(true);
    expect(PolicyError.matches('Refused.', { param: 'status' })).toBe(true);
    expect(PolicyError.matches('Refused.', { param: 'status' }, 'plan_required')).toBe(false);
    expect(PolicyError.matches('Forbidden.', null)).toBe(false);
  });
});

describe('P4: CodeConflictError', () => {
  it('carries the held code and its type, as a 409 ConflictError', () => {
    const error = new CodeConflictError('Someone holds SUMMER.', 'SUMMER', 'coupon');
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.name).toBe('CodeConflictError');
    expect(error.statusCode).toBe(409);
    expect(error.conflictingCode).toBe('SUMMER');
    expect(error.type).toBe('coupon');
  });

  it.skip('fromConflict keeps the conflict\'s message, status, code and data, and sets it as the cause', () => {
    const conflict = new ConflictError('Someone already holds that code.', {
      code: 'code_held',
      statusCode: 409,
      data: { holder: 'dashboard' },
    });
    const error = CodeConflictError.fromConflict(conflict, 'SUMMER', 'coupon');

    expect(error).toBeInstanceOf(CodeConflictError);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.message).toBe('Someone already holds that code.');
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe('code_held');
    expect(error.data).toEqual({ holder: 'dashboard' });
    expect(error.cause).toBe(conflict);
    expect(error.conflictingCode).toBe('SUMMER');
    expect(error.type).toBe('coupon');
  });
});

describe('P5: HoldConflictError', () => {
  function hold(message: string, code?: string): HoldConflictError {
    return HoldConflictError.fromConflict(new ConflictError(message, { code, statusCode: 409 }));
  }

  it('the transport keeps a 409 with a hold code a plain ConflictError, as the PHP SDK does', async () => {
    const error = await thrownBy(409, err('No credit available.', 'hold_no_credit'));
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).not.toBeInstanceOf(HoldConflictError);
    expect(error).not.toBeInstanceOf(CodeConflictError);
  });

  it.skip('fromConflict keeps the conflict\'s message, status, code and data, and sets it as the cause', () => {
    const conflict = new ConflictError('No credit available in USD.', {
      code: 'hold_no_credit',
      statusCode: 409,
      data: { currency: 'USD' },
    });
    const error = HoldConflictError.fromConflict(conflict);

    expect(error).toBeInstanceOf(HoldConflictError);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.name).toBe('HoldConflictError');
    expect(error.message).toBe('No credit available in USD.');
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe('hold_no_credit');
    expect(error.data).toEqual({ currency: 'USD' });
    expect(error.cause).toBe(conflict);
  });

  it.skip('reads the reason from the two hold codes, whatever the message says', () => {
    expect(hold('Anything.', 'hold_no_credit').reason).toBe('no_credit');
    expect(hold('Credit is held under that token.', 'hold_no_credit').reason).toBe('no_credit');
    expect(hold('Anything.', 'hold_token_in_use').reason).toBe('token_in_use');
    expect(hold('There is no credit available.', 'hold_token_in_use').reason).toBe('token_in_use');
  });

  it.skip('answers null for any other code this SDK knows, whatever the message says', () => {
    expect(hold('There is no credit available.', 'hold_currency_not_at_store').reason).toBeNull();
    expect(hold('Credit is held under that token.', 'mapping_exists').reason).toBeNull();
  });

  it.skip('reads the reason from the wording when there is no code, in any case', () => {
    expect(hold('Another checkout holds credit UNDER THAT TOKEN.').reason).toBe('token_in_use');
    expect(hold('There is No Credit Available in USD.').reason).toBe('no_credit');
  });

  it.skip('reads the reason from the wording when the code is unknown', () => {
    expect(hold('Another checkout holds credit under that token.', 'legacy_hold').reason).toBe('token_in_use');
  });

  it.skip('checks the token wording before the credit wording', () => {
    expect(hold('No credit available under that token.').reason).toBe('token_in_use');
  });

  it.skip('answers null for other wording with no code', () => {
    expect(hold('The hold was refused.').reason).toBeNull();
  });
});
