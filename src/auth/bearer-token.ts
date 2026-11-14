/**
 * The one rule for a bearer token the SDK will send. The transport applies it
 * to every `getAccessToken` and `refreshAccessToken` answer, and
 * `StaticAccessToken` applies it when it is built, so `new Siren({ apiKey })`
 * refuses a bad key before anything is sent.
 *
 * Answers the token when it is a non-empty string in which every character is
 * at most U+00FF and none is a control character (C0, U+0000 to U+001F, DEL,
 * U+007F, or C1, U+0080 to U+009F), else `null`. Siren's tokens are ASCII, so
 * the only other characters that pass are U+00A0 to U+00FF.
 *
 * A C0 control character in a header value makes fetch quote the whole value
 * in its error, and a C1 control such as U+0085 (next line) is a line break to
 * some readers. Fetch refuses a character above U+00FF before it sends, and a
 * client that writes headers as Latin-1 keeps only the low byte, so U+010A
 * would go out as a line feed. A character outside the Basic Multilingual
 * Plane is two UTF-16 code units, both above U+00FF, so it is refused too.
 *
 * @internal
 */
export function usableBearerToken(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return /[\u0000-\u001f\u007f-\u009f\u0100-\uffff]/.test(value) ? null : value;
}
