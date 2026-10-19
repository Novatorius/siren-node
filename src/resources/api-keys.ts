import type { HttpClient } from '../http';
import type { ApiKey, CreateApiKeyParams, CreatedApiKey } from '../types';

/**
 * Manage API keys (`/api-keys`).
 *
 * These routes take a signed-in dashboard session's access token, passed as
 * `apiKey`. No API key scope reaches them, so Siren answers an API key with a
 * 401 that the SDK throws as `ApiKeyNotAcceptedError`.
 */
export class ApiKeysResource {
  constructor(private readonly http: HttpClient) {}

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
   */
  create(params: CreateApiKeyParams): Promise<CreatedApiKey> {
    return this.http.requestData<CreatedApiKey>({
      method: 'POST',
      path: '/api-keys',
      body: params,
      retriable: false,
    });
  }

  /** List API keys (raw key material is never included). */
  list(): Promise<ApiKey[]> {
    return this.http.requestData<ApiKey[]>({
      method: 'GET',
      path: '/api-keys',
      retriable: true,
    });
  }

  /** Revoke an API key. */
  async revoke(id: number): Promise<void> {
    await this.http.request({
      method: 'DELETE',
      path: `/api-keys/${encodeURIComponent(String(id))}`,
      retriable: true,
    });
  }
}
