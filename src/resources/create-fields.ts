import { SirenError } from '../errors';

/**
 * The body a create sends: a new object holding each `allowed` own key of
 * `params` whose value is not `undefined`. Throws `SirenError` with the
 * message `refuse(key)` for the first own key that is not allowed, whatever
 * its value, `undefined` included, so nothing is sent.
 *
 * Reading only own enumerable keys into a new object means a `toJSON` or any
 * other member `params` inherits never reaches the body.
 *
 * @internal
 */
export function pickFields(
  params: object,
  allowed: readonly string[],
  refuse: (key: string) => string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) throw new SirenError(refuse(key));
    const value: unknown = (params as Record<string, unknown>)[key];
    if (value !== undefined) body[key] = value;
  }
  return body;
}
