import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appRequest } from '@novatorius/siren/testing';
import { TEST_API_KEY } from './helpers';

/*
 * The feature page's Node.js samples, packet apps-answer-handler. Each file
 * in test/answer-samples is the design's section 5 sample as written
 * (design/sdk-answer-handler.md in the apps run folder): 5.1's first lines
 * and server line, with the kind's function between them. The README
 * carries the same text, and test/docs-apps-request-handler.test.ts holds
 * the two equal.
 *
 * Only what a sample leaves to the developer is stubbed: `addToCrm` and
 * `noteShare` on globalThis, the two environment variables, and Express's
 * `listen(3000)`, which listens on a free port of 127.0.0.1 instead. The
 * rest is real: the SDK from source, Express, and the global fetch the SDK
 * sends with, which here is a fake Siren. The fake signs Siren's own request
 * (test/fixtures/apps-feature-contracts/requests.json) with a test secret,
 * with appRequest() from the testing entry, as WebhookSignature::headers()
 * does, posts it to the sample, and takes the answer the sample posts to
 * Siren Cloud's address, api.sirenaffiliates.com.
 */

const started = vi.hoisted(() => [] as Server[]);

vi.mock('express', async (importOriginal) => {
  type App = { listen: (...args: unknown[]) => Server };
  const real = ((await importOriginal()) as { default: (...args: unknown[]) => App }).default;
  const wrapped = Object.assign((...args: unknown[]) => {
    const app = real(...args);
    const listen = app.listen.bind(app);
    // The sample's listen(3000) listens on a free port of 127.0.0.1 instead.
    app.listen = () => {
      const server = listen(0, '127.0.0.1');
      started.push(server);
      return server;
    };
    return app;
  }, real);
  return { default: wrapped };
});

// Each sample loads the SDK from source on its first import, which can pass
// Vitest's 5 seconds on a busy machine, and took 50 seconds under a load
// average of 40.
vi.setConfig({ testTimeout: 120_000 });

interface FeatureFixture {
  kinds: Record<string, { request: Record<string, unknown>; answer: Record<string, unknown> | null }>;
}
const features = JSON.parse(
  readFileSync(new URL('./fixtures/apps-feature-contracts/requests.json', import.meta.url), 'utf8'),
) as FeatureFixture;
const SECRET = 'test-signing-secret-for-the-samples';
const ID = 'apr_9c60190a4501399d0ae55f041c237b39';

interface Posted {
  url: string;
  authorization: string | null;
  body: unknown;
}

let posted: Posted[] = [];

beforeEach(() => {
  posted = [];
  vi.stubEnv('SIREN_API_KEY', TEST_API_KEY);
  vi.stubEnv('SIREN_SIGNING_SECRET', SECRET);
  const loopback = globalThis.fetch;
  // The fake Siren: the answer route on api.sirenaffiliates.com, and the guard's loopback for the sample's own server.
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).hostname !== 'api.sirenaffiliates.com') return loopback(input, init);
    const headers = new Headers(init?.headers);
    posted.push({ url, authorization: headers.get('authorization'), body: JSON.parse(String(init?.body)) as unknown });
    return new Response(JSON.stringify({ status: 'accepted' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(started.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

/** Loads one sample and answers the address its Express app listens on. */
async function load(sample: string): Promise<string> {
  await import(`./answer-samples/${sample}.js`);
  const server = started.at(-1);
  if (server === undefined) throw new Error(`${sample} started no server`);
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/siren`;
}

/**
 * Siren's request for `kind`, signed by appRequest() from the package's
 * testing entry with the fixture's id, app and feature key, posted to the
 * sample.
 */
async function sirenSends(url: string, kind: string, test = false): Promise<{ status: number; body: unknown }> {
  const request = features.kinds[kind]!.request as { app: string; feature: { key: string } };
  const { method, headers, rawBody } = appRequest(kind, request.feature.key, { id: ID, app: request.app, ...(test ? { test } : {}) });
  const response = await fetch(url, { method, headers, body: rawBody });
  return { status: response.status, body: (await response.json()) as unknown };
}

async function eventually(check: () => void): Promise<void> {
  for (let tries = 0; ; tries += 1) {
    try {
      check();
      return;
    } catch (error) {
      if (tries > 200) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

describe('apps-answer-handler: the section 5 samples, run as written', () => {
  it('5.1 postConversionAction: the tell gets its 200 once addToCrm has run', async () => {
    const addToCrm = vi.fn(async () => undefined);
    vi.stubGlobal('addToCrm', addToCrm);
    const url = await load('post-conversion-action');
    expect(await sirenSends(url, 'postConversionAction')).toEqual({ status: 200, body: {} });
    const data = features.kinds.postConversionAction!.request.data as Record<string, unknown>;
    expect(addToCrm).toHaveBeenCalledWith(ID, data.conversion, data.reward);
    expect(posted).toEqual([]);
  });

  it('5.2 postAllocationAction: the tell gets its 200 once noteShare has run', async () => {
    const noteShare = vi.fn(async () => undefined);
    vi.stubGlobal('noteShare', noteShare);
    const url = await load('post-allocation-action');
    expect(await sirenSends(url, 'postAllocationAction')).toEqual({ status: 200, body: {} });
    const data = features.kinds.postAllocationAction!.request.data as Record<string, unknown>;
    expect(noteShare).toHaveBeenCalledWith(ID, data.allocation);
    expect(posted).toEqual([]);
  });

  it('5.3 distributionResolver: the ask gets its 200 at once, and Siren receives the fixture answer', async () => {
    const url = await load('distribution-resolver');
    expect(await sirenSends(url, 'distributionResolver')).toEqual({ status: 200, body: {} });
    await eventually(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      url: `https://api.sirenaffiliates.com/siren/v1/apps/requests/${ID}/answer`,
      authorization: `Bearer ${TEST_API_KEY}`,
      body: features.kinds.distributionResolver!.answer,
    });
  });

  it('5.4 incentiveResolver: the ask gets its 200 at once, and Siren receives the fixture answer', async () => {
    const url = await load('incentive-resolver');
    expect(await sirenSends(url, 'incentiveResolver')).toEqual({ status: 200, body: {} });
    await eventually(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      url: `https://api.sirenaffiliates.com/siren/v1/apps/requests/${ID}/answer`,
      authorization: `Bearer ${TEST_API_KEY}`,
      body: features.kinds.incentiveResolver!.answer,
    });
  });

  it('5.5 programGroupSorter: the ask gets its 200 at once, and Siren receives the fixture answer', async () => {
    const url = await load('program-group-sorter');
    expect(await sirenSends(url, 'programGroupSorter')).toEqual({ status: 200, body: {} });
    await eventually(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      url: `https://api.sirenaffiliates.com/siren/v1/apps/requests/${ID}/answer`,
      authorization: `Bearer ${TEST_API_KEY}`,
      body: features.kinds.programGroupSorter!.answer,
    });
  });

  it('5.6 incentiveType: the ask gets its 200 at once, and Siren receives the fixture answer', async () => {
    const url = await load('incentive-type');
    expect(await sirenSends(url, 'incentiveType')).toEqual({ status: 200, body: {} });
    await eventually(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      url: `https://api.sirenaffiliates.com/siren/v1/apps/requests/${ID}/answer`,
      authorization: `Bearer ${TEST_API_KEY}`,
      body: features.kinds.incentiveType!.answer,
    });
  });
});

/*
 * The README's sample for every other kind, the feature page's Node.js tab
 * (frontend/src/platform/saas/apps/featureContracts.ts on Siren's
 * feat/apps). Each runs on Siren's own question for its kind. Where the
 * sample's choice differs from the fixture's example answer, the expected
 * answer is worked out from the question by hand, and it keeps the
 * fixture answer's outcome and shape.
 */
describe("apps-docs: every other kind's sample, run as written", () => {
  async function asked(sample: string, kind: string): Promise<unknown> {
    const url = await load(sample);
    expect(await sirenSends(url, kind)).toEqual({ status: 200, body: {} });
    await eventually(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.url).toBe(`https://api.sirenaffiliates.com/siren/v1/apps/requests/${ID}/answer`);
    expect(posted[0]!.authorization).toBe(`Bearer ${TEST_API_KEY}`);
    const body = posted[0]!.body as Record<string, unknown>;
    expect(body.outcome).toBe((features.kinds[kind]!.answer as Record<string, unknown>).outcome);
    return body;
  }

  it('payoutMethod: pays once and answers paid with the reference, the fixture answer', async () => {
    const payOnce = vi.fn(async () => ({ ok: true, id: 'acme-ledger-5521' }));
    vi.stubGlobal('payOnce', payOnce);
    expect(await asked('payout-method', 'payoutMethod')).toEqual(features.kinds.payoutMethod!.answer);
    const data = features.kinds.payoutMethod!.request.data as Record<string, { id?: number }>;
    expect(payOnce).toHaveBeenCalledWith(88, data.collaborator, data.amount);
  });

  it('payoutMethod: answers a test request at once, paying nothing and calling no provider', async () => {
    const payOnce = vi.fn(async () => ({ ok: true, id: 'acme-ledger-5521' }));
    vi.stubGlobal('payOnce', payOnce);
    const url = await load('payout-method');
    expect(await sirenSends(url, 'payoutMethod', true)).toEqual({ status: 200, body: {} });
    await eventually(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.body).toEqual({ outcome: 'failed', reason: 'A test request, so nothing was paid.' });
    expect(payOnce).not.toHaveBeenCalled();
  });

  it('metricCalculation: scores the triggering collaborator 1 for a visit', async () => {
    expect(await asked('metric-calculation', 'metricCalculation')).toEqual({ outcome: 'scores', results: [{ collaboratorId: 42, score: 1 }] });
  });

  it('metricFilter: suppresses a refunded sale with the fixture answer', async () => {
    const isRefunded = vi.fn(() => true);
    vi.stubGlobal('isRefunded', isRefunded);
    expect(await asked('metric-filter', 'metricFilter')).toEqual(features.kinds.metricFilter!.answer);
    expect(isRefunded).toHaveBeenCalledWith(3307);
  });

  it('engagementCalculation: credits the triggering collaborator 10 when Siren knows the customer', async () => {
    expect(await asked('engagement-calculation', 'engagementCalculation')).toEqual({
      outcome: 'engagements',
      results: [{ collaboratorId: 42, score: 10 }],
    });
  });

  it('engagementFilter: suppresses a visit from staff with the fixture answer', async () => {
    const isStaff = vi.fn(() => true);
    vi.stubGlobal('isStaff', isStaff);
    expect(await asked('engagement-filter', 'engagementFilter')).toEqual(features.kinds.engagementFilter!.answer);
    expect(isStaff).toHaveBeenCalledWith(42, 77);
  });

  it('transactionFilter: includes only the line items, the fixture answer', async () => {
    expect(await asked('transaction-filter', 'transactionFilter')).toEqual(features.kinds.transactionFilter!.answer);
  });

  it('collaboratorGroupStructure: a chain by rank, the fixture answer', async () => {
    expect(await asked('collaborator-group-structure', 'collaboratorGroupStructure')).toEqual(
      features.kinds.collaboratorGroupStructure!.answer,
    );
  });
});
