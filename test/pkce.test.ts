import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SirenError } from '../src/index';
import { codeChallengeS256, createCodeVerifier, createState } from '../src/connect/index';
import { shown } from './error-text';


vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});

/*
 * Slice 5 acceptance tests for packet P1: PKCE and state helpers.
 *
 * The done condition: the S256 challenge matches RFC 7636's test vector
 * (Appendix B). The second vector is a 64-digit hex verifier, the shape
 * Siren's OAuthConnectService::begin() makes, whose challenge Node's crypto,
 * `openssl dgst -sha256 -binary | base64url` and PHP's
 * `rtrim(strtr(base64_encode(hash('sha256', $v, true)), '+/', '-_'), '=')`
 * all gave as written here.
 *
 * The randomness tests replace `node:crypto`'s `randomBytes` with a spy over
 * the real one, so they can check that each value is exactly the bytes the
 * secure source gave, in hex.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const HEX_VERIFIER = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('P1: codeChallengeS256', () => {
  it.each([
    ['RFC 7636 Appendix B', 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'],
    ['a hex verifier as Siren makes one', HEX_VERIFIER, 'qK5ubukpq-o6_PxSWMjM1vhSc-DUYm0mxyefMlD3fI4'],
  ])('gives the S256 challenge for %s', (_name, verifier, challenge) => {
    expect(codeChallengeS256(verifier)).toBe(challenge);
  });

  it.each([
    ['43 characters, the shortest RFC 7636 allows', 'a'.repeat(43)],
    ['128 characters, the longest', 'Z'.repeat(128)],
    ['every unreserved character', 'AZaz09-._~'.repeat(5)],
  ])('takes a verifier of %s', (_name, verifier) => {
    expect(codeChallengeS256(verifier)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it.each([
    ['42 characters', 'S3CRETverifier'.padEnd(42, 'q')],
    ['129 characters', 'S3CRETverifier'.padEnd(129, 'q')],
    ['a plus sign', 'S3CRETverifier+'.padEnd(43, 'q')],
    ['a slash', 'S3CRETverifier/'.padEnd(43, 'q')],
    ['a space', 'S3CRETverifier '.padEnd(43, 'q')],
    ['an equals sign', 'S3CRETverifier='.padEnd(43, 'q')],
    ['a line break', 'S3CRETverifier\n'.padEnd(43, 'q')],
    ['a letter outside ASCII', 'S3CRETverifieré'.padEnd(43, 'q')],
  ])('refuses a verifier with %s, without quoting it', (_name, verifier) => {
    let caught: unknown;
    try {
      codeChallengeS256(verifier);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SirenError);
    expect(shown(caught)).not.toContain('S3CRET');
  });

  it.each([[undefined], [null], [43], [['a'.repeat(43)]]])('refuses %j, which is not a string', (value) => {
    expect(() => codeChallengeS256(value as unknown as string)).toThrow(SirenError);
  });
});

describe('P1: createCodeVerifier', () => {
  it('answers 64 lower-case hex digits, 32 random bytes, whose challenge is an S256 challenge', () => {
    const verifier = createCodeVerifier();

    expect(verifier).toMatch(/^[0-9a-f]{64}$/);
    expect(codeChallengeS256(verifier)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("is exactly the 32 bytes node:crypto's randomBytes gives, in hex", () => {
    const bytes = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256));
    vi.mocked(randomBytes).mockReturnValueOnce(bytes as never);

    expect(createCodeVerifier()).toBe(bytes.toString('hex'));
    expect(vi.mocked(randomBytes)).toHaveBeenCalledWith(32);
  });

  it('answers a new value every call, from every hex digit, never from Math.random', () => {
    const random = vi.spyOn(Math, 'random');
    const verifiers = Array.from({ length: 200 }, () => createCodeVerifier());

    expect(new Set(verifiers).size).toBe(200);
    expect(new Set(verifiers.join('')).size).toBe(16);
    expect(random).not.toHaveBeenCalled();
  });
});

describe('P1: createState', () => {
  it('answers 32 lower-case hex digits, 16 random bytes', () => {
    expect(createState()).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is exactly the 16 bytes node:crypto's randomBytes gives, in hex", () => {
    const bytes = Buffer.from(Array.from({ length: 16 }, (_, i) => (i * 53 + 7) % 256));
    vi.mocked(randomBytes).mockReturnValueOnce(bytes as never);

    expect(createState()).toBe(bytes.toString('hex'));
    expect(vi.mocked(randomBytes)).toHaveBeenCalledWith(16);
  });

  it('answers a new value every call, from every hex digit, never from Math.random', () => {
    const random = vi.spyOn(Math, 'random');
    const states = Array.from({ length: 200 }, () => createState());

    expect(new Set(states).size).toBe(200);
    expect(new Set(states.join('')).size).toBe(16);
    expect(random).not.toHaveBeenCalled();
  });
});
