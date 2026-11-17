import { describe, expect, it } from 'vitest';
import { SirenError, UnexpectedResponseError } from '../src/errors';
import { AppsResource } from '../src/resources/apps';
import { reply } from './http-fakes';
import { transportOver } from './record-fakes';

import { APP_KEY, appRecord } from './apps-siren-answers';

/*
 * The implementer's tests for packet sdk-apps, beside the acceptance tests in
 * test/apps-resource.test.ts. Each app route answers an app as
 * AppSerializer::toArray() gives it (lib/Apps/Service/Services/AppSerializer.php
 * on Novatorius/siren `feat/apps` at 1619218d0), so every read and write of
 * one checks for a text `key` and an `items` list, and a declare that sends
 * secrets sends them as text.
 */

const app = appRecord();
const notAnApp = { ...app, items: undefined };

function apps(replies: Parameters<typeof transportOver>[0]) {
  const over = transportOver(replies);
  return { ...over, apps: new AppsResource(over.transport) };
}

async function refused(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('the call answered instead of refusing');
}

describe('apps answers that are not apps', () => {
  it('refuses a list with a row that is not an app, and names the route', async () => {
    const { apps: resource } = apps([reply(200, [app, notAnApp])]);
    const error = await refused(() => resource.list());
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as Error).message).toContain('GET /apps');
    expect((error as UnexpectedResponseError).data).toEqual([app, notAnApp]);
  });

  it('refuses a retrieve, a status change and a rotation that answer something else', async () => {
    const runs: Array<(resource: AppsResource) => Promise<unknown>> = [
      (resource) => resource.retrieve(APP_KEY),
      (resource) => resource.setStatus(APP_KEY, 'active'),
      (resource) => resource.rotate(APP_KEY),
    ];
    for (const run of runs) {
      const { apps: resource } = apps([reply(200, { ...notAnApp, rawKey: 'sk_test_x', signingSecret: 'y' })]);
      expect(await refused(() => run(resource)), run.toString()).toBeInstanceOf(UnexpectedResponseError);
    }
  });

  it('refuses a declare whose secrets are not text', async () => {
    const { apps: resource } = apps([reply(201, { ...app, rawKey: 7, signingSecret: 8 })]);
    expect(await refused(() => resource.declare(APP_KEY, { name: 'Acme', url: 'https://acme.example/siren' }))).toBeInstanceOf(
      UnexpectedResponseError,
    );
  });

  it('refuses a bad key on every call that takes one, before sending', async () => {
    const runs: Array<(resource: AppsResource) => Promise<unknown>> = [
      (resource) => resource.setStatus('Acme', 'active'),
      (resource) => resource.rotate('requests'),
      (resource) => resource.delete('acme/payouts'),
      (resource) => resource.declare(APP_KEY, null as never),
    ];
    for (const run of runs) {
      const { http, apps: resource } = apps([reply(200, app)]);
      expect(await refused(() => run(resource)), run.toString()).toBeInstanceOf(SirenError);
      expect(http.requests).toHaveLength(0);
    }
  });
});
