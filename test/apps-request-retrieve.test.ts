import { describe, expect, it } from 'vitest';
import { Siren } from '../src/client';
import { ApiKeyNotAcceptedError, NotFoundError, SirenError, UnexpectedResponseError, appErrorCode } from '../src/errors';
import { AppsResource } from '../src/resources/apps';
import type { AppRequestDetail } from '../src/record-types';
import { capturedBody, capturedReply } from './cloud-captures';
import { FakeHttpClient, reply } from './http-fakes';
import { BASE, expectRetried, pathOf, transportOver } from './record-fakes';
import { AppAnswers } from './apps-siren-answers';

/*
 * `siren.apps.requests.retrieve(id)`: one request, with the data Siren sent
 * and the answer it took, from `GET /apps/requests/{requestKey}`
 * (lib/Apps/Service/Rest/GetAppRequest.php and
 * AppRequestSerializer::toDetail() lines 87 to 97, on Novatorius/siren
 * feat/apps at 27169452a). The answers are the second Cloud run's captures,
 * from feat/apps at 57999d085.
 */

const ONE = 'apps-request-one-200-needs-attention';
const ID = 'apr_e221f712e2dd08c2daa566d3ac5ce340';

function resource(replies: Parameters<typeof transportOver>[0]) {
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

describe('apps-sdk-followups-1: apps.requests.retrieve()', () => {
  it('reads one request with GET /apps/requests/{requestKey}, and answers it with its data, answer and who answered', async () => {
    const http = new FakeHttpClient([capturedReply(ONE)]);
    const siren = new Siren({ apiKey: 'made-up-key', baseUrl: BASE, httpClient: http });
    const detail: AppRequestDetail = await siren.apps.requests.retrieve(ID);
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]?.method).toBe('GET');
    expect(pathOf(http.requests[0]!)).toBe(`/apps/requests/${ID}`);
    expect(http.requests[0]?.body).toBeUndefined();
    expect(detail).toEqual(capturedBody(ONE));
    expect(detail.status).toBe('needs_attention');
    expect(detail.data).toMatchObject({ conversion: { id: 2 }, program: { name: 'Partners' } });
    expect(detail.answer).toBeNull();
    expect(detail.answeredByUser).toBeNull();
  });

  it('retries as a read', async () => {
    await expectRetried((transport) => new AppsResource(transport).requests.retrieve(ID), capturedReply(ONE));
  });

  it('refuses an id that is not a request key before sending', async () => {
    for (const id of ['apr_1', 'APR_E221F712E2DD08C2DAA566D3AC5CE340', '', 7, null, `${ID}/answer`]) {
      const { http, apps } = resource([capturedReply(ONE)]);
      const error = await refused(() => apps.requests.retrieve(id as string));
      expect(error, String(id)).toBeInstanceOf(SirenError);
      expect((error as Error).message).toContain('apps.requests.retrieve()');
      expect(http.requests).toHaveLength(0);
    }
  });

  it("raises Siren's 404 as NotFoundError with app_request_not_found, and an app's key as ApiKeyNotAcceptedError", async () => {
    for (const answer of [capturedReply('apps-request-one-404'), AppAnswers.requestNotFound()]) {
      const { apps } = resource([answer]);
      const error = await refused(() => apps.requests.retrieve(ID));
      expect(error).toBeInstanceOf(NotFoundError);
      expect(appErrorCode(error)).toBe('app_request_not_found');
      expect((error as Error).message).toBe('App request not found.');
    }
    const { apps } = resource([reply(401, { error: { message: 'This route takes a signed-in session.', code: 'api_key_not_accepted', context: [] } })]);
    expect(await refused(() => apps.requests.retrieve(ID))).toBeInstanceOf(ApiKeyNotAcceptedError);
  });

  it('raises UnexpectedResponseError, with the status and the body, for a 2xx body of the wrong shape', async () => {
    const good = capturedBody<Record<string, unknown>>(ONE);
    for (const body of [[], { ...good, id: 7 }, { ...good, id: 'apr_00000000000000000000000000000000' }, { ...good, data: [] }, { ...good, data: null }, { ...good, answer: 'paid' }, { ...good, answeredByUser: 'jane' }, { requests: [good] }]) {
      const { apps } = resource([reply(200, body)]);
      const error = await refused(() => apps.requests.retrieve(ID));
      expect(error, JSON.stringify(body).slice(0, 80)).toBeInstanceOf(UnexpectedResponseError);
      expect((error as UnexpectedResponseError).statusCode).toBe(200);
    }
    const answered = { ...good, status: 'applied', answer: { outcome: 'paid', reference: 'TX-1' }, answeredBy: 'user:5', answeredByUser: { id: 5, email: 'jane@store.invalid' } };
    const { apps } = resource([reply(200, answered)]);
    expect(await apps.requests.retrieve(ID)).toEqual(answered);
  });
});
