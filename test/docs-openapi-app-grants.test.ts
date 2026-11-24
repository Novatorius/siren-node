import { describe, expect, it } from 'vitest';
import { specServes } from './spec-routes';

/*
 * Siren's openapi.json against Siren feat/apps 6d2abd936a: POST /oauth/token
 * takes the app's client_credentials grant (saas/Rest/OAuth/IssueToken.php),
 * and an app request has an answer route. The generated spec carries routes,
 * not the grant and refusal prose, so test/app-tokens.test.ts keeps those.
 */

describe("openapi.json: the app routes Siren has", () => {
  it('serves POST /oauth/token', () => {
    expect(specServes('post', '/oauth/token')).toBe(true);
  });

  it('serves POST /apps/requests/{id}/answer', () => {
    expect(specServes('post', '/apps/requests/{id}/answer')).toBe(true);
  });
});
