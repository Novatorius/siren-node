import { describe, expect, it } from 'vitest';
import { ConflictError, MappingsResource, PolicyError, SirenError, UnexpectedResponseError } from '../src/index';
import type { HttpTransport } from '../src/http';
import { reply } from './http-fakes';
import { bodyOf, expectRetried, expectSentOnce, page, pathOf, queryOf, transportOver } from './record-fakes';
import { MappingAnswers } from './record-fakes-2';

/*
 * Slice 4 acceptance tests for packet P6: MappingsResource, the `/mappings`
 * routes. Cases follow the Siren PHP SDK's MappingsTest (siren-php 0.3.0),
 * with Cloud's answers from test/record-fakes-2.ts.
 *
 * Integration shape (KB 568): the real resource over the real HttpTransport,
 * with a FakeHttpClient at the HttpClient seam.
 *
 * INCOMPLETE MARKER: every `it.skip` below is the architecture phase's
 * incomplete marker. The P6 implementer turns each into `it` and deletes this
 * paragraph.
 */

function over(replies: Parameters<typeof transportOver>[0]) {
  const built = transportOver(replies);
  return { ...built, mappings: new MappingsResource(built.transport) };
}

const resource = (transport: HttpTransport) => new MappingsResource(transport);

/** The site's row as the SDK answers it: the plain type, with the Property beside it. */
const plainSiteRow = { localId: 4, externalId: '17', localType: 'collaborator', externalType: 'wordpress_user', propertyId: 5 };
const plainOrgRow = { localId: 4, externalId: 'flo-at-crm', localType: 'collaborator', externalType: 'crm_contact', propertyId: null };

describe('P6: mappings surface', () => {
  it('names the collaborator type, the WordPress user type and the filters', () => {
    expect(MappingsResource.LOCAL_TYPE_COLLABORATOR).toBe('collaborator');
    expect(MappingsResource.EXTERNAL_TYPE_WORDPRESS_USER).toBe('wordpress_user');
    expect(MappingsResource.LIST_FILTERS).toEqual(['localId', 'localType', 'externalId', 'externalType']);
    expect(MappingsResource.ID_FILTERS).toEqual({ many: ['localId'] });
  });
});

describe('P6: mappings reads', () => {
  it.skip('lists GET /mappings and answers every row with its plain type and Property', async () => {
    const { http, mappings } = over([reply(200, page([MappingAnswers.siteRow, MappingAnswers.orgRow], 2, 20))]);

    const list = await mappings.list({ externalType: 'wordpress_user', localType: 'collaborator', number: 20, orderBy: 'localId' });

    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['GET', '/mappings']);
    expect(queryOf(http.requests[0])).toEqual({
      externalType: 'wordpress_user',
      localType: 'collaborator',
      number: '20',
      orderBy: 'localId',
    });
    expect([...list]).toEqual([plainSiteRow, plainOrgRow]);
    expect(list.estimatedCount).toBe(2);
  });

  it.skip("finds an outside record's links with forExternal, the id trimmed", async () => {
    const { http, mappings } = over([reply(200, page([MappingAnswers.siteRow]))]);

    expect([...(await mappings.forExternal(' 17 ', 'wordpress_user', 'collaborator', { number: 5 }))]).toEqual([plainSiteRow]);
    expect(queryOf(http.requests[0])).toEqual({
      externalId: '17',
      externalType: 'wordpress_user',
      localType: 'collaborator',
      number: '5',
    });
  });

  it.skip('leaves localType out of forExternal when it is not given', async () => {
    const { http, mappings } = over([reply(200, page([]))]);

    await mappings.forExternal('17', 'wordpress_user');

    expect(queryOf(http.requests[0])).toEqual({ externalId: '17', externalType: 'wordpress_user' });
  });

  it.skip("finds a Siren record's links with forLocal", async () => {
    const { http, mappings } = over([reply(200, page([MappingAnswers.siteRow]))]);

    expect([...(await mappings.forLocal(4, 'collaborator', 'wordpress_user', { orderBy: 'externalId' }))]).toEqual([plainSiteRow]);
    expect(queryOf(http.requests[0])).toEqual({
      localId: '4',
      localType: 'collaborator',
      externalType: 'wordpress_user',
      orderBy: 'externalId',
    });
  });

  it.skip('retries every read', async () => {
    await expectRetried((transport) => resource(transport).list({ externalType: 'wordpress_user' }), reply(200, page([])));
    await expectRetried((transport) => resource(transport).forExternal('17', 'wordpress_user'), reply(200, page([])));
    await expectRetried((transport) => resource(transport).forLocal(4, 'collaborator', 'wordpress_user'), reply(200, page([])));
  });

  it.skip('throws UnexpectedResponseError for a 2xx that is not a list', async () => {
    await expect(over([reply(200, { error: 'x' })]).mappings.list({ externalType: 'wordpress_user' })).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
  });
});

describe('P6: mappings writes', () => {
  it.skip('links a collaborator with POST /mappings, the id trimmed, and answers the plain link', async () => {
    const { http, mappings } = over([reply(201, MappingAnswers.created)]);

    expect(await mappings.create(4, ' 17 ', 'wordpress_user')).toEqual(plainSiteRow);
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['POST', '/mappings']);
    expect(http.requests[0]!.body).toBe('{"localId":4,"localType":"collaborator","externalId":"17","externalType":"wordpress_user"}');
  });

  it.skip('raises an existing link as ConflictError with its code', async () => {
    const error = await over([reply(409, MappingAnswers.exists)])
      .mappings.create(4, '17', 'wordpress_user')
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe('mapping_exists');
  });

  it.skip("raises a site's user type as PolicyError naming the parameter", async () => {
    const error = await over([reply(403, MappingAnswers.userTypeNotAllowed)])
      .mappings.create(4, '17', 'user')
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PolicyError);
    expect((error as PolicyError).code).toBe('user_type_not_allowed');
  });

  it.skip("removes a collaborator's links of one type with DELETE /mappings and no body", async () => {
    const { http, mappings } = over([reply(200, MappingAnswers.deleted)]);

    expect(await mappings.deleteForCollaborator(4, 'wordpress_user')).toEqual({ deleted: true });
    expect([http.requests[0]!.method, pathOf(http.requests[0])]).toEqual(['DELETE', '/mappings']);
    expect(queryOf(http.requests[0])).toEqual({ localType: 'collaborator', localId: '4', externalType: 'wordpress_user' });
    expect(http.requests[0]!.body).toBeUndefined();
  });

  it.skip("removes an outside record's collaborator links, the id trimmed", async () => {
    const { http, mappings } = over([reply(200, MappingAnswers.deleted)]);

    expect(await mappings.deleteForExternal(' 17 ', 'wordpress_user')).toEqual({ deleted: true });
    expect(queryOf(http.requests[0])).toEqual({ localType: 'collaborator', externalId: '17', externalType: 'wordpress_user' });
  });

  it.skip.each([
    ['deleteForCollaborator', (m: MappingsResource) => m.deleteForCollaborator(4, 'wordpress_user')],
    ['deleteForExternal', (m: MappingsResource) => m.deleteForExternal('17', 'wordpress_user')],
  ])('%s throws UnexpectedResponseError when a 2xx carries no object', async (_name, call) => {
    await expect(call(over([reply(204)]).mappings)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it.skip('sends every write once', async () => {
    await expectSentOnce((transport) => resource(transport).create(4, '17', 'wordpress_user'), reply(201, MappingAnswers.created));
    await expectSentOnce((transport) => resource(transport).deleteForCollaborator(4, 'wordpress_user'), reply(200, MappingAnswers.deleted));
    await expectSentOnce((transport) => resource(transport).deleteForExternal('17', 'wordpress_user'), reply(200, MappingAnswers.deleted));
  });
});

describe('P6: mappings names and ids', () => {
  it.skip('list refuses a query with no externalType, so it never lists every link', async () => {
    const { http, mappings } = over([reply(200, page([]))]);

    await expect(mappings.list({ localType: 'collaborator', localId: 4 })).rejects.toBeInstanceOf(SirenError);
    await expect(mappings.list()).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });

  it.skip.each([
    ['list, a qualified externalType', (m: MappingsResource) => m.list({ externalType: 'wordpress_user@property:5' })],
    ['list, an externalType with a comma', (m: MappingsResource) => m.list({ externalType: 'wordpress_user,wc_product' })],
    ['list, a localType with a comma', (m: MappingsResource) => m.list({ externalType: 'wordpress_user', localType: 'a,b' })],
    ['list, a zero localId', (m: MappingsResource) => m.list({ externalType: 'wordpress_user', localId: 0 })],
    ['list, a localId list with a string', (m: MappingsResource) => m.list({ externalType: 'wordpress_user', localId: [4, '5'] as never })],
    ['list, propertyId', (m: MappingsResource) => m.list({ externalType: 'wordpress_user', propertyId: 5 } as never)],
    ['forExternal, a blank id', (m: MappingsResource) => m.forExternal('   ', 'wordpress_user')],
    ['forExternal, an empty type', (m: MappingsResource) => m.forExternal('17', '')],
    ['forExternal, a bad localType', (m: MappingsResource) => m.forExternal('17', 'wordpress_user', 'col/laborator')],
    ['forLocal, a zero id', (m: MappingsResource) => m.forLocal(0, 'collaborator', 'wordpress_user')],
    ['forLocal, a bad localType', (m: MappingsResource) => m.forLocal(4, 'a b', 'wordpress_user')],
    ['create, a zero collaborator', (m: MappingsResource) => m.create(0, '17', 'wordpress_user')],
    ['create, a blank id', (m: MappingsResource) => m.create(4, ' ', 'wordpress_user')],
    ['create, a qualified type', (m: MappingsResource) => m.create(4, '17', 'wordpress_user@property:5')],
    ['deleteForCollaborator, a fractional id', (m: MappingsResource) => m.deleteForCollaborator(1.5, 'wordpress_user')],
    ['deleteForCollaborator, a type with a comma', (m: MappingsResource) => m.deleteForCollaborator(4, 'a,b')],
    ['deleteForExternal, a blank id', (m: MappingsResource) => m.deleteForExternal('', 'wordpress_user')],
    ['deleteForExternal, an empty type', (m: MappingsResource) => m.deleteForExternal('17', '')],
  ])('%s is refused with SirenError before sending', async (_name, call) => {
    const { http, mappings } = over([reply(200, page([]))]);

    await expect(call(mappings)).rejects.toBeInstanceOf(SirenError);
    expect(http.requests).toHaveLength(0);
  });
});
