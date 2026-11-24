import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * openapi.yaml against Siren feat/apps 6d2abd936a: POST /oauth/token takes
 * the app's client_credentials grant (saas/Rest/OAuth/IssueToken.php and
 * saas/Auth/AppTokenGrant.php), and the answer route names every 409
 * (lib/Apps/Core/Models/AppAnswerResult.php).
 */

const openapi = readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8');

function route(path: string): string {
  const start = openapi.indexOf(`\n  ${path}:\n`);
  expect(start, path).toBeGreaterThan(-1);
  const next = openapi.slice(start + 1).search(/\n {2}\/[^\n]*:\n/);
  return openapi.slice(start, next === -1 ? undefined : start + 1 + next);
}

describe('openapi.yaml: the app grants and refusals Siren has', () => {
  it('lists client_credentials as a grant on POST /oauth/token, with its fields and lifetimes', () => {
    const token = route('/oauth/token');
    expect(token).toContain('enum: [authorization_code, refresh_token, client_credentials]');
    expect(token).toContain('client_secret:');
    expect(token).toContain('browser:{eventKey}');
    expect(token).toContain('1200');
    expect(token).toContain('600');
  });

  it('says a key that is no app\'s gets 400 unauthorized_client at /oauth/token', () => {
    const token = route('/oauth/token').replace(/\s+/g, ' ');
    expect(token).toContain('unauthorized_client');
    expect(token).toContain("Only an app's key can get an access token.");
  });

  it('names 409 app_request_dropped and app_request_not_needing_attention on the answer route', () => {
    const answer = route('/apps/requests/{id}/answer');
    expect(answer).toContain('409 app_request_dropped');
    expect(answer).toContain('app_request_not_needing_attention');
  });
});
