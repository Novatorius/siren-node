import { describe, expect, it } from 'vitest';
import { ConnectorScope } from '../src/index';

/*
 * Slice 2 acceptance tests for packet P6: ConnectorScope.
 *
 * The four values and CONNECTED_SITE are vocabulary, written in full in the
 * architecture commit, so their tests run now. They come from the PHP SDK's
 * ConnectorScope at 59383e6 and Siren's ConnectorTokenMiddleware READ_SCOPE
 * and WRITE_SCOPE at bb49b7d.
 *
 * INCOMPLETE MARKER: a test written `it.skip(` belongs to the packet named in
 * its describe block. That packet's implementer turns `it.skip(` into `it(`
 * for its own tests and changes nothing else here.
 */

describe('ConnectorScope vocabulary', () => {
  it('names the four scopes a connected site asks for', () => {
    expect(ConnectorScope.ConnectAll).toBe('connect:*');
    expect(ConnectorScope.Webhooks).toBe('connect:webhooks');
    expect(ConnectorScope.RecordsRead).toBe('connect:records:read');
    expect(ConnectorScope.RecordsWrite).toBe('connect:records:write');
  });

  it('joins all four with single spaces in CONNECTED_SITE', () => {
    expect(ConnectorScope.CONNECTED_SITE).toBe(
      'connect:* connect:webhooks connect:records:read connect:records:write',
    );
  });
});

describe('P6: ConnectorScope.forConnectedSite', () => {
  it.skip('answers the four scopes in the order of CONNECTED_SITE', () => {
    expect(ConnectorScope.forConnectedSite()).toEqual([
      'connect:*',
      'connect:webhooks',
      'connect:records:read',
      'connect:records:write',
    ]);
    expect(ConnectorScope.forConnectedSite().join(' ')).toBe(ConnectorScope.CONNECTED_SITE);
  });

  it.skip('answers a new list each call, so a caller that changes one cannot change the next', () => {
    const first = ConnectorScope.forConnectedSite();
    first.pop();

    expect(ConnectorScope.forConnectedSite()).toHaveLength(4);
  });
});
