/*
 * PKCE (RFC 7636) and state helpers for a connected site's OAuth handshake.
 * They mirror Siren's OAuthConnectService::begin(): the verifier is 32
 * random bytes as hex, the state 16 random bytes as hex, and the challenge
 * the S256 method, base64url SHA-256 with no padding. Each is a pure
 * function. The store keeps the verifier and the state, never the SDK.
 *
 * The module imports `randomBytes` as `import { randomBytes } from
 * 'node:crypto'`, the exact specifier its tests intercept.
 */

import { createHash, randomBytes } from 'node:crypto';
import { SirenError } from '../errors';

/** RFC 7636 section 4.1: 43 to 128 unreserved characters. */
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

/**
 * A new code verifier: 64 lower-case hex digits from 32 bytes of the
 * operating system's secure random source, `randomBytes(32)` from
 * `node:crypto`, as PHP's
 * `bin2hex(random_bytes(32))`. It fits RFC 7636's 43 to 128 unreserved
 * characters.
 */
export function createCodeVerifier(): string {
  return randomBytes(32).toString('hex');
}

/**
 * A new `state` value: 32 lower-case hex digits from 16 bytes of the
 * operating system's secure random source, `randomBytes(16)` from
 * `node:crypto`, as PHP's
 * `bin2hex(random_bytes(16))`.
 */
export function createState(): string {
  return randomBytes(16).toString('hex');
}

/**
 * The S256 code challenge for a verifier: the SHA-256 digest of its ASCII
 * bytes, base64url encoded with no padding (RFC 7636 section 4.2). Always 43
 * characters.
 *
 * Throws `SirenError` when the verifier is not 43 to 128 characters of
 * `A-Z`, `a-z`, `0-9`, `-`, `.`, `_` and `~`, the rule in RFC 7636 section
 * 4.1, and never quotes the verifier in the message.
 */
export function codeChallengeS256(verifier: string): string {
  if (typeof verifier !== 'string' || !VERIFIER.test(verifier)) {
    throw new SirenError(
      'Siren: codeChallengeS256 needs a verifier of 43 to 128 characters from A-Z, a-z, 0-9, "-", ".", "_" and "~" (RFC 7636 section 4.1).',
    );
  }
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}
