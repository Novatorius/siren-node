import { describe, expect, it } from 'vitest';
import { CollaboratorsResource, SITE_CREATABLE_COLLABORATOR_FIELDS, SirenError } from '../src/index';
import { reply } from './http-fakes';
import { bodyOf, CollaboratorAnswers, transportOver } from './record-fakes';

/*
 * Slice 3 acceptance tests for `collaborators.createPending`'s allow list.
 * Cloud's create route (lib/Collaborators/Rest/Service/CreateNewCollaborator.php
 * at b6f7140) reads fullName, nickname, email, status, trackingId and the
 * three binding lists. A connected site sends fullName, nickname, email and
 * an optional trackingId, as the PHP SDK documents, the SDK sets status,
 * and every other key is refused before sending, since the route does not
 * read it.
 *
 * Integration shape, per "Integration Testing Standards — Introduction"
 * (KB 568, https://navigator.novatori.us/r/kb/568): the real
 * CollaboratorsResource over the real HttpTransport, with a FakeHttpClient
 * at the HttpClient seam.
 */

function over() {
  const built = transportOver([reply(201, CollaboratorAnswers.created)]);
  return { ...built, collaborators: new CollaboratorsResource(built.transport) };
}

const params = { fullName: 'Ada Lovelace', nickname: 'ada', email: 'ada@example.com' };

describe('P3: collaborators.createPending allow list', () => {
  it('names the fields a site may send on create', () => {
    expect(SITE_CREATABLE_COLLABORATOR_FIELDS).toEqual(['fullName', 'nickname', 'email', 'trackingId']);
  });

  it('sends exactly the allowed fields, trackingId included, and status pending', async () => {
    const { http, collaborators } = over();

    await collaborators.createPending({ ...params, trackingId: 'ADA' });

    expect(http.requests).toHaveLength(1);
    expect(bodyOf(http.requests[0])).toEqual({ ...params, trackingId: 'ADA', status: 'pending' });
  });

  it.each([
    ['id', 7],
    ['id', undefined],
    ['propertyId', 5],
    ['fields', { tier: 'gold' }],
    ['referralCode', 'ADA'],
  ])("refuses a caller's %s (%j) with SirenError naming it, and sends nothing", async (field, value) => {
    const { http, collaborators } = over();

    const error = await collaborators
      .createPending({ ...params, trackingId: 'ADA', [field]: value } as never)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toBe(
      `createPending cannot send "${field}". A connected site sends only fullName, nickname, email and trackingId.`,
    );
    expect(http.requests).toHaveLength(0);
  });
});
