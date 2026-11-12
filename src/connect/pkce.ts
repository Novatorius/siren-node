/*
 * PKCE (RFC 7636) and state helpers for a connected site's OAuth handshake.
 * They mirror Siren's OAuthConnectService::begin(): the verifier is 32
 * random bytes as hex, the state 16 random bytes as hex, and the challenge
 * the S256 method, base64url SHA-256 with no padding. Each is a pure
 * function. The store keeps the verifier and the state, never the SDK.
 */

/**
 * A new code verifier: 64 lower-case hex digits from 32 bytes of the
 * operating system's secure random source, as PHP's
 * `bin2hex(random_bytes(32))`. It fits RFC 7636's 43 to 128 unreserved
 * characters.
 */
export function createCodeVerifier(): string {
  // Stub: slice 5 packet P1.
  return '0'.repeat(64);
}

/**
 * A new `state` value: 32 lower-case hex digits from 16 bytes of the
 * operating system's secure random source, as PHP's
 * `bin2hex(random_bytes(16))`.
 */
export function createState(): string {
  // Stub: slice 5 packet P1.
  return '0'.repeat(32);
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
  // Stub: slice 5 packet P1.
  void verifier;
  return 'A'.repeat(43);
}
