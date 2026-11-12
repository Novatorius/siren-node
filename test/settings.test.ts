import { describe, expect, it } from 'vitest';
import { BadRequestError, SettingsResource, SirenError, UnexpectedResponseError } from '../src/index';
import type { HttpTransport } from '../src/http';
import { reply } from './http-fakes';
import { expectRetried, page, pathOf, queryOf, transportOver } from './record-fakes';
import { SettingAnswers } from './record-fakes-2';

/*
 * Slice 4 acceptance tests for packet P7: SettingsResource, the shared
 * settings on `GET /configs`. Cases follow the Siren PHP SDK's SettingsTest
 * (siren-php 0.3.0), with Cloud's answers from test/record-fakes-2.ts.
 *
 * Integration shape (KB 568): the real resource over the real HttpTransport,
 * with a FakeHttpClient at the HttpClient seam.
 *
 * INCOMPLETE MARKER: every `it.skip` below is the architecture phase's
 * incomplete marker. The P7 implementer turns each into `it` and deletes this
 * paragraph.
 */

const NAME_MESSAGE = (field: string) => `A setting ${field} must be a name with no comma.`;

function over(replies: Parameters<typeof transportOver>[0]) {
  const built = transportOver(replies);
  return { ...built, settings: new SettingsResource(built.transport) };
}

const resource = (transport: HttpTransport) => new SettingsResource(transport);

describe('P7: settings surface', () => {
  it('names the route, the collaborator type and the filters', () => {
    expect(SettingsResource.PATH).toBe('/configs');
    expect(SettingsResource.TYPE_COLLABORATOR).toBe('collaborator');
    expect(SettingsResource.FILTERS).toEqual(['type', 'subtype', 'configKey']);
  });
});

describe('P7: settings reads', () => {
  it.skip('reads the shared collaborator settings with type=collaborator and number=200', async () => {
    const { http, settings } = over([reply(200, page([SettingAnswers.urlReference], 1, 200))]);

    expect([...(await settings.collaborator())]).toEqual([SettingAnswers.urlReference]);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['GET', '/configs']);
    expect(queryOf(http.requests[0])).toEqual({ type: 'collaborator', number: '200' });
  });

  it.skip("answers one setting's value, read with all three names and number 1", async () => {
    const { http, settings } = over([reply(200, page([SettingAnswers.urlReference], 1, 1))]);

    expect(await settings.value('collaborator', 'urlReference', 'key')).toBe('via');
    expect(queryOf(http.requests[0])).toEqual({ type: 'collaborator', subtype: 'urlReference', configKey: 'key', number: '1' });
  });

  it.skip('answers null when Siren shares no such setting, or the row has no value', async () => {
    const { settings } = over([reply(200, page([])), reply(200, page([{ type: 'collaborator', subtype: 'urlReference', configKey: 'key' }]))]);

    expect(await settings.value('collaborator', 'urlReference', 'other')).toBeNull();
    expect(await settings.value('collaborator', 'urlReference', 'key')).toBeNull();
  });

  it.skip('raises a type Siren does not share as BadRequestError', async () => {
    await expect(over([reply(400, SettingAnswers.typeRefused)]).settings.value('program', 'x', 'y')).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });

  it.skip.each([
    ['collaborator', (s: SettingsResource) => s.collaborator()],
    ['value', (s: SettingsResource) => s.value('collaborator', 'urlReference', 'key')],
  ])('%s throws UnexpectedResponseError for a 2xx that is not a list', async (_name, call) => {
    await expect(call(over([reply(200, { value: 'via' })]).settings)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it.skip('retries every read', async () => {
    await expectRetried((transport) => resource(transport).collaborator(), reply(200, page([])));
    await expectRetried((transport) => resource(transport).value('collaborator', 'urlReference', 'key'), reply(200, page([])));
  });

  it.skip.each([
    ['type', ['', 'urlReference', 'key']],
    ['subtype', ['collaborator', 'url,Reference', 'key']],
    ['configKey', ['collaborator', 'urlReference', 7]],
  ] as const)('value refuses a bad %s with its own message before sending', async (field, names) => {
    const { http, settings } = over([reply(200, page([]))]);

    const error = await settings
      .value(names[0] as string, names[1] as string, names[2] as unknown as string)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toBe(NAME_MESSAGE(field));
    expect(http.requests).toHaveLength(0);
  });
});
