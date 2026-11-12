import { SirenError } from '../errors';
import type { SirenErrorDetails } from '../errors';

/**
 * Siren Cloud refused an OAuth call with the RFC 6749 error envelope,
 * `{ "error": "...", "error_description": "..." }`.
 *
 * `code` holds the envelope's `error`, such as `invalid_grant`, and
 * `statusCode` the HTTP status. The message is the `error_description`, or
 * the code when Cloud sent none. A refresh answered 400 or 401 with
 * `invalid_grant` or `invalid_client` means Cloud refused the grant itself:
 * the site was disconnected, or its refresh token was spent or expired, so it
 * must connect again. Any other status, a 429 or 5xx included, raises the
 * SDK's usual error for that status instead.
 */
export class OAuthError extends SirenError {
  declare readonly code: string;
  declare readonly statusCode: number;

  constructor(message: string, details: SirenErrorDetails & { code: string; statusCode: number }) {
    super(message, details);
    this.name = 'OAuthError';
  }
}
