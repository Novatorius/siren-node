import { describe, expect, it } from 'vitest';
import {
  ConnectScope,
  ConnectorScope,
  ConnectorSoftware,
  DEFAULT_CONSENT_SCREEN_URL,
  DEFAULT_OAUTH_TIMEOUT_MS,
  OAuthErrorCode,
} from '../src/connect/index';

/*
 * Slice 5 vocabulary tests. These values are written in full in the
 * architecture commit, so the tests run now and belong to no packet. Each
 * list is copied from Siren at b6f7140d0.
 */

describe('connect vocabulary', () => {
  it("names the six operation scopes of Siren's connect resource, in ScopeService's order", () => {
    // lib/OAuth/Core/Services/ScopeService.php line 37.
    expect(Object.values(ConnectScope)).toEqual([
      'connect:read',
      'connect:ingest',
      'connect:migrate',
      'connect:webhooks',
      'connect:records:read',
      'connect:records:write',
    ]);
  });

  it('asks, through CONNECTED_SITE, for the wildcard and each explicit-only scope by name', () => {
    // ScopeService.php line 41: EXPLICIT_ONLY.
    const asked = ConnectorScope.CONNECTED_SITE.split(' ');
    expect(asked).toContain('connect:*');
    for (const scope of [ConnectScope.Webhooks, ConnectScope.RecordsRead, ConnectScope.RecordsWrite]) {
      expect(asked, scope).toContain(scope);
    }
  });

  it("names the connector software Siren's ConnectorSoftware enum takes at registration", () => {
    // lib/OAuth/Core/Enums/ConnectorSoftware.php lines 22 and 25.
    expect(ConnectorSoftware).toEqual({ WordPress: 'siren-wordpress', Medusa: 'siren-medusa' });
  });

  it("names the OAuth error codes Siren's OAuth routes answer with", () => {
    // saas/Rest/OAuth/IssueToken.php, saas/Rest/OAuth/RegisterOAuthClient.php and OAuthService.php.
    expect(Object.values(OAuthErrorCode).sort()).toEqual(
      [
        'invalid_client',
        'invalid_client_metadata',
        'invalid_grant',
        'invalid_redirect_uri',
        'invalid_request',
        'invalid_scope',
        'unsupported_grant_type',
      ].sort(),
    );
  });

  it("defaults to Siren Cloud's consent screen and a 15 second OAuth wait", () => {
    // lib/WordPress/Connect/WpConnectUrlProvider.php and WpOAuthProviderClient.php.
    expect(DEFAULT_CONSENT_SCREEN_URL).toBe('https://api.sirenaffiliates.com/connect-site');
    expect(DEFAULT_OAUTH_TIMEOUT_MS).toBe(15_000);
  });
});
