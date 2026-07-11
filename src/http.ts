import { ConnectionError, errorFromResponse } from './errors';

export const DEFAULT_BASE_URL = 'https://api.sirenaffiliates.com/siren/v1';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 2;

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

export interface HttpClientOptions {
  apiKey: string;
  baseUrl: string;
  timeout: number;
  maxRetries: number;
}

export interface SirenRequest {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /**
   * Whether this request may be auto-retried on network errors and 429/5xx.
   * Idempotent reads and event ingestion retry; management writes must not.
   */
  retriable: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseJsonBody(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return undefined;
  }
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}


/**
 * Internal transport. Builds URLs, attaches auth, enforces the timeout, maps
 * failures to typed errors, and retries retriable requests with exponential
 * backoff (honoring `Retry-After` on 429).
 */
export class HttpClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly maxRetries: number;

  constructor(options: HttpClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeout = options.timeout;
    this.maxRetries = options.maxRetries;
  }

  /** Perform a request and return the raw `Response` (guaranteed 2xx). */
  async request(req: SirenRequest): Promise<Response> {
    const url = this.buildUrl(req);
    const init = this.buildInit(req);
    const maxAttempts = req.retriable ? this.maxRetries + 1 : 1;

    let lastCause: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let response: Response;
      try {
        response = await this.fetchWithTimeout(url, init);
      } catch (cause) {
        lastCause = cause;
        if (attempt + 1 < maxAttempts) {
          await sleep(this.backoffDelay(attempt));
          continue;
        }
        throw new ConnectionError(
          `Request to ${url} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }

      if (response.ok) return response;

      const shouldRetry =
        (response.status === 429 || response.status >= 500) && attempt + 1 < maxAttempts;
      if (shouldRetry) {
        await sleep(this.backoffDelay(attempt, response.headers.get('retry-after')));
        continue;
      }

      const body = await parseJsonBody(response);
      throw errorFromResponse(
        response.status,
        response.statusText,
        body,
        response.headers.get('retry-after'),
      );
    }

    /* istanbul ignore next -- the loop always returns or throws */
    throw new ConnectionError(`Request to ${url} failed`, { cause: lastCause });
  }

  /**
   * Perform a request and return the parsed JSON body. The API returns bare
   * payloads (no `{ data }` envelope): a bare object for create/read-by-id, a
   * bare array for list endpoints.
   */
  async requestData<T>(req: SirenRequest): Promise<T> {
    const response = await this.request(req);
    const body = await parseJsonBody(response);
    return body as T;
  }

  private buildUrl(req: SirenRequest): string {
    let url = `${this.baseUrl}${req.path}`;
    if (req.query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(req.query)) {
        if (value === undefined || value === null) continue;
        params.append(key, String(value));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }
    return url;
  }

  private buildInit(req: SirenRequest): RequestInit {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      'User-Agent': 'siren-sdk-typescript/0.1.0',
    };
    const init: RequestInit = { method: req.method, headers };
    if (req.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(req.body);
    }
    return init;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private backoffDelay(attempt: number, retryAfterHeader?: string | null): number {
    if (retryAfterHeader != null) {
      const seconds = Number(retryAfterHeader);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, MAX_BACKOFF_MS);
      }
    }
    return Math.min(INITIAL_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  }
}
