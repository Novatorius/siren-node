import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAppFile } from '../src/cli/app-file';
import { jsonResponse } from './helpers';

/*
 * Slice C13 (apps-event-tokens): the README's "Send a custom event" shows
 * the server and page halves of examples/apps/signups. These hold the
 * README to the example's text, then run that text.
 */

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const SERVER = readFileSync(new URL('../examples/apps/signups/server.mjs', import.meta.url), 'utf8');
const PAGE = readFileSync(new URL('../examples/apps/signups/page.mjs', import.meta.url), 'utf8');
const KEY = `sk_live_${'c'.repeat(64)}`;
const SEND_URL = 'https://api.sirenaffiliates.com/siren/v1/event/newsletter-signup';
/**
 * A body Siren takes: CustomEventIngestion::ingest() reads `collaboratorId`
 * at the top level and answers 400 "collaboratorId is required" without it,
 * then checks the event's fields, here `list`.
 */
const SIREN_BODY = { collaboratorId: 12, list: 'weekly' };

/** The text between `// README: {name}` and `// README end` in an example file. */
function marked(text: string, name: string): string {
  const start = text.indexOf(`// README: ${name}\n`);
  const end = text.indexOf('// README end');
  expect(start).toBeGreaterThanOrEqual(0);
  return text.slice(start + `// README: ${name}\n`.length, end).trimEnd();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('README: Send a custom event', () => {
  it('shows the server and page code exactly as the example holds it', () => {
    expect(README).toContain('```js\n' + marked(SERVER, 'server') + '\n```');
    expect(README).toContain('```js\n' + marked(PAGE, 'page') + '\n```');
  });

  it("runs the server snippet: a send with the app's key goes out with a token, and the handler answers a browser token", async () => {
    vi.stubEnv('SIREN_API_KEY', KEY);
    const calls: Array<{ url: string; auth: string | undefined; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        calls.push({ url, auth: (init.headers as Record<string, string>).Authorization, body });
        if (url.endsWith('/oauth/token')) {
          return jsonResponse(200, { access_token: body.scope ? 'browser-jwt' : 'server-jwt', token_type: 'Bearer', expires_in: body.scope ? 600 : 1200 });
        }
        return jsonResponse(200, { status: 'recorded' });
      }),
    );
    const { recordSignup, browserTokens } = await import('../examples/apps/signups/server.mjs');

    expect((await recordSignup(12, 'weekly')).status).toBe('recorded');
    expect(calls.at(-1)).toEqual({ url: SEND_URL, auth: 'Bearer server-jwt', body: SIREN_BODY });

    const response = await browserTokens(new Request('https://example.com/siren/token', { method: 'POST', body: '{"event":"newsletter-signup"}' }));
    expect(await response.json()).toEqual({ token: 'browser-jwt', expiresIn: 600, url: SEND_URL });
    const refused = await browserTokens(new Request('https://example.com/siren/token', { method: 'POST', body: '{"event":"other"}' }));
    expect(refused.status).toBe(400);
  });

  it('runs the page snippet: a submit asks /siren/token and sends with the browser token', async () => {
    const urls: string[] = [];
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        urls.push(url);
        bodies.push(JSON.parse(init.body as string));
        if (url === '/siren/token') return jsonResponse(200, { token: 'browser-jwt', expiresIn: 600, url: SEND_URL });
        return jsonResponse(200, { status: 'recorded' });
      }),
    );
    const { wireSignupForm } = await import('../examples/apps/signups/page.mjs');
    let submit: ((event: { preventDefault(): void }) => Promise<void>) | undefined;
    const form = { dataset: { collaboratorId: '12' }, addEventListener: (_type: string, listener: typeof submit) => (submit = listener) };

    wireSignupForm(form);
    await submit?.({ preventDefault: () => undefined });

    expect(urls).toEqual(['/siren/token', `${SEND_URL}?access_token=browser-jwt`]);
    expect(bodies.at(-1)).toEqual(SIREN_BODY);
  });

  it("holds an app file the CLI reads, with the event's domains", () => {
    const text = readFileSync(new URL('../examples/apps/signups/siren.app.json', import.meta.url), 'utf8');
    const parsed = parseAppFile(text, {});

    expect(parsed.problems).toEqual([]);
    expect(parsed.file?.apps.signups?.items?.['newsletter-signup']?.domains).toEqual(['localhost', 'example.com', '*.example.com']);
  });
});
