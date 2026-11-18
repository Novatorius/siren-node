import { UnexpectedResponseError } from '../errors';
import { parseJsonBody, type HttpTransport } from '../http';
import type { ApiKey, ApiKeyScopeGroups, CreateApiKeyParams, CreatedApiKey } from '../types';

/**
 * Manage API keys (`/api-keys`).
 *
 * These routes take a signed-in dashboard session's access token, passed as
 * `apiKey`. No API key scope reaches them, so Siren answers an API key with a
 * 401 that the SDK throws as `ApiKeyNotAcceptedError`.
 *
 * Deprecated: an app holds its key now, and each method names the app call
 * that replaces it. These calls go when Siren removes `/api-keys`.
 */
export class ApiKeysResource {
  constructor(private readonly http: HttpTransport) {}

  /**
   * Create a new API key.
   *
   * The plaintext `rawKey` (`sk_live_...`) is returned exactly once and
   * cannot be retrieved later — store it securely. This write is never
   * auto-retried.
   *
   * `scopes` must hold at least one scope from `ApiKeyScope`: event scopes
   * to send events, ledger scopes such as `ledger:conversions:read` to read
   * the ledger, and `webhook-subscriptions:read` or
   * `webhook-subscriptions:manage` to read or manage webhook subscriptions.
   * Siren answers 400 for an older resource scope such as `programs:read`.
   *
   * @deprecated An app holds its key now. Make one with `apps.createKey()`, or `apps.create()` with
   * `scopes`. This call goes when Siren removes its route.
   */
  create(params: CreateApiKeyParams): Promise<CreatedApiKey> {
    return this.http.requestData<CreatedApiKey>({
      method: 'POST',
      path: '/api-keys',
      body: params,
      retriable: false,
    });
  }

  /**
   * List API keys (raw key material is never included).
   *
   * @deprecated An app holds its key now. Read each app's `apiKey` from `apps.list()`. This call
   * goes when Siren removes its route.
   */
  list(): Promise<ApiKey[]> {
    return this.http.requestData<ApiKey[]>({
      method: 'GET',
      path: '/api-keys',
      retriable: true,
    });
  }

  /**
   * The scopes a new key may be given, grouped by resource, from
   * `GET /api-keys/scopes`, such as `events`, `ledger` and
   * `webhook-subscriptions`, each a list of `{ scope, resource, action, label }`.
   * Siren answers it for a signed-in dashboard session only, like every
   * `/api-keys` route. It throws `UnexpectedResponseError` when the
   * body is not an object, a group is not a list, or an entry is not an
   * object. It is a retriable read, like `list()`: the transport retries it
   * on 429 and 5xx up to `maxRetries`.
   *
   * @deprecated An app holds its key now. Read the scopes an app's key may hold from
   * `apps.scopes()`. This call goes when Siren removes its route.
   */
  async scopes(): Promise<ApiKeyScopeGroups> {
    const path = '/api-keys/scopes';
    const response = await this.http.request({ method: 'GET', path, retriable: true });
    const body = await parseJsonBody(response);
    const isObject = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value);
    const isGroup = (group: unknown): boolean => Array.isArray(group) && group.every(isObject);
    if (!isObject(body) || !Object.values(body).every(isGroup)) {
      throw new UnexpectedResponseError(
        `Siren answered GET ${path} with a body that is not an object of scope lists.`,
        { statusCode: response.status, data: body },
      );
    }
    return body as ApiKeyScopeGroups;
  }

  /**
   * Revoke an API key.
   *
   * @deprecated An app holds its key now. Revoke it with `apps.revokeKey()`. This call goes when
   * Siren removes its route.
   */
  async revoke(id: number): Promise<void> {
    await this.http.request({
      method: 'DELETE',
      path: `/api-keys/${encodeURIComponent(String(id))}`,
      retriable: true,
    });
  }
}
