import { describe, expect, it } from 'vitest';
import { SirenConnect } from '../src/connect/index';
import { FakeHttpClient, reply } from './http-fakes';
import { ConnectAnswers } from './connect-fakes';

/*
 * Unit tests for how the SirenConnect constructor reads its options. It
 * checks `apiKey` and `accessToken` itself, then hands its one reading of
 * every option to `createHttpTransport`, so a getter that changes its answer
 * between reads cannot pass the checks with one value and reach the
 * transport with another.
 */

const KEY = 'sk_live_APIKEYSECRET_123';

/** Options whose `apiKey` getter answers undefined, then a key, and whose `accessToken` getter answers a token, then undefined. */
function flipping(http: FakeHttpClient, reads: Record<string, number>) {
  const answers: Record<string, unknown[]> = {
    apiKey: [undefined, KEY],
    accessToken: ['tok-site', undefined],
  };
  const options: Record<string, unknown> = {};
  for (const [name, [first, later]] of Object.entries(answers)) {
    Object.defineProperty(options, name, {
      enumerable: true,
      get() {
        reads[name] = (reads[name] ?? 0) + 1;
        return reads[name] === 1 ? first : later;
      },
    });
  }
  Object.defineProperty(options, 'httpClient', {
    enumerable: true,
    get() {
      reads.httpClient = (reads.httpClient ?? 0) + 1;
      return http;
    },
  });
  return options;
}

describe('SirenConnect reads each option once', () => {
  it('sends the access token it checked, never an apiKey a getter answers later', async () => {
    const http = new FakeHttpClient([reply(200, ConnectAnswers.ping)]);
    const siren = new SirenConnect(flipping(http, {}) as never);

    await siren.connect.ping();

    expect(http.bearers()).toEqual(['Bearer tok-site']);
  });

  it('reads apiKey, accessToken and httpClient one time each', () => {
    const http = new FakeHttpClient([]);
    const reads: Record<string, number> = {};

    new SirenConnect(flipping(http, reads) as never);

    expect(reads).toEqual({ apiKey: 1, accessToken: 1, httpClient: 1 });
  });
});
