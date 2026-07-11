import type { HttpClient } from '../http';
import type { ApiKey, CreateApiKeyParams, CreatedApiKey } from '../types';

/** Manage API keys (`/api-keys`). */
export class ApiKeysResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Create a new API key.
   *
   * The plaintext `rawKey` (`sk_live_...`) is returned exactly once and
   * cannot be retrieved later — store it securely. This write is never
   * auto-retried.
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
