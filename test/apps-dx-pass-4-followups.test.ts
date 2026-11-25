import { afterEach, describe, expect, it, vi } from 'vitest';
import { Siren } from '../src/client';
import { AppSlowTellError } from '../src/errors';
import type { AppLogger } from '../src/resources/app-request-handler';
import { webhookEvent } from '../src/testing';
import { TEST_API_KEY } from './helpers';
import { FakeHttpClient } from './http-fakes';
import { BASE } from './record-fakes';

/*
 * Pass 4 follow-up 2 (review/sdk-dx/pass-4-followups-spec.md): Siren sends a
 * webhook event to an app's address with the same 8-second timeout as a
 * tell, so an onEvent function past 8 seconds runs twice. The handler times
 * it as it times a tell, with siren-php's wording (AppRequestHandler::checkTime()
 * on pkt/apps-dx). The clock is vitest's fake Date.
 */

const SECRET = 'a-secret-for-pass-4-followups';
const DELIVERY = 'evt_0123456789abcdef0123456789abcdef';
const WORDING =
  'conversion.approved took 9.0 s. Siren stops waiting at 8 s and sends the event again, so it ran twice. ' +
  'Save what you need, hand the slow part to runLater or your own queue, and return.';

function setup(options: { onError?: (error: unknown, request?: unknown) => void; logger?: AppLogger } = {}) {
  const siren = new Siren({ apiKey: TEST_API_KEY, baseUrl: BASE, httpClient: new FakeHttpClient([]), maxRetries: 0 });
  return siren.apps.requestHandler({
    signingSecret: SECRET,
    ...(options.onError ? { onError: options.onError } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
}

const slowEvent = (answers: ReturnType<typeof setup>, seconds: number) =>
  answers.onEvent('conversion.approved', () => {
    vi.setSystemTime(Date.now() + seconds * 1000);
  });

const event = () => webhookEvent('conversion.approved', undefined, { secret: SECRET, deliveryId: DELIVERY });

afterEach(() => {
  vi.useRealTimers();
});

describe("follow-up 2: an event function past Siren's 8 seconds", () => {
  it('replies 200, and hands onError an AppSlowTellError in PHP\'s words, with the event', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const errors: Array<[unknown, unknown]> = [];
    const answers = setup({ onError: (error, request) => errors.push([error, request]) });
    slowEvent(answers, 9);
    const result = await answers.handle(event());
    expect(result.status).toBe(200);
    expect(errors).toHaveLength(1);
    expect(errors[0]![0]).toBeInstanceOf(AppSlowTellError);
    expect((errors[0]![0] as Error).message).toBe(WORDING);
    expect(errors[0]![1]).toEqual(expect.objectContaining({ type: 'conversion.approved', deliveryId: DELIVERY }));
  });

  it('writes the default as one warn line naming the event type and delivery id', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const lines: string[] = [];
    const errorLines: string[] = [];
    const logger: AppLogger = { debug: () => undefined, info: () => undefined, warn: (l) => lines.push(l), error: (l) => errorLines.push(l) };
    const answers = setup({ logger });
    slowEvent(answers, 9);
    await answers.handle(event());
    expect(errorLines).toEqual([]);
    expect(lines).toEqual([`Siren request handler (conversion.approved ${DELIVERY}): AppSlowTellError: ${WORDING}`]);
  });

  it('gives simulate() the same error, and nothing for an event inside the limit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const late = setup();
    slowEvent(late, 9);
    const result = await late.simulate(event());
    expect(result.status).toBe(200);
    expect(result.error).toBeInstanceOf(AppSlowTellError);
    expect((result.error as Error).message).toBe(WORDING);

    const quick = setup();
    slowEvent(quick, 8);
    expect((await quick.simulate(event())).error).toBeNull();
  });
});
