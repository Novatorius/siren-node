import { SignatureVerificationError, SirenError } from '../errors';
import type { HttpTransport } from '../http';
import type { AppEventFunction, AppFeatureFunctions, AppRequest, AppRequestFunction } from '../record-types';
import type { WebhookEvent, WebhookHeaders } from '../types';
import type { NodeResponseLike } from './events';
import { answerAppRequest, appRequestFrom, checkSignedDelivery, MAX_TOLERANCE_SECONDS } from './app-requests';
import { isJsonObject } from './record-requests';
import { readHeader, webhookEventFrom } from './webhooks';

/*
 * The short way to answer Siren from an app: one handler that checks each
 * request, hands it to the app's function for its kind and key, and sends
 * the reply Siren expects, including an ask's answer after the reply.
 * Contract: docs/architecture/apps-request-handler.md. `apps.requestHandler()`
 * (apps.ts) builds it. Everything it checks and sends goes through
 * app-requests.ts, the same code `apps.verifyRequest()` and
 * `apps.requests.answer()` use.
 */

/** The most bytes the handler reads of a body it reads itself, far past any request Siren sends. */
export const APP_REQUEST_BODY_LIMIT = 1024 * 1024;

/** What the handler answers when a body parser already read the body. */
const PARSED_BODY =
  'The request body was already parsed, so its signature cannot be checked. ' +
  'Mount the Siren handler before the JSON body parser, or give its route a raw body, ' +
  "such as express.raw({ type: 'application/json' }).";

const REPLY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

/** Options for `apps.requestHandler()`. */
export interface AppRequestHandlerOptions {
  /**
   * The app's signing secret, which Siren showed when it made the app's
   * address. `undefined` is refused when the handler is made, so
   * `process.env.SIREN_SIGNING_SECRET` can be passed as it is.
   */
  signingSecret: string | undefined;
  /** How far a request's signed time may be from this machine's clock, either way. Whole seconds from 1 to 3600. Default 300. */
  toleranceSeconds?: number;
  /**
   * Takes the work an ask does after its reply: running the function and
   * posting its answer. The work never rejects. Without it, a Node server
   * runs the work in the process, a host that passes `ctx.waitUntil` as the
   * third argument (Cloudflare Workers) gets it there, and any other Web host
   * runs it as a promise nothing awaits. Pass Next.js's `after` on Vercel.
   */
  runLater?: (work: () => Promise<void>) => void;
  /**
   * Gets every error the handler does not show Siren: a function that threw,
   * an answer that broke the rules, Siren's refusal of an answer, and a body
   * a parser already read. `request` is the checked request or event, when
   * there is one. Default `console.error`.
   */
  onError?: (error: unknown, request?: AppRequest | WebhookEvent) => void;
}

/** One request as any server reads it, for `handle()`. */
export interface AppRequestInput {
  /** The HTTP method. Only POST is served. Read as POST when left out. */
  method?: string;
  /** The request headers, as a Fetch `Headers` object or a plain object in any case. */
  headers: WebhookHeaders;
  /** The exact bytes received, as a string or bytes. Anything else, such as a parsed object, gets 500. */
  rawBody: unknown;
}

/**
 * What `handle()` answers: the reply to send, and for an ask, the work to
 * run once it is sent. `after` never rejects.
 */
export interface AppRequestReply {
  status: number;
  headers: Record<string, string>;
  /** JSON text: `{}`, or `{"error": "..."}`. */
  body: string;
  after?: () => Promise<void>;
}

/** The part of Node's `IncomingMessage`, or Express's request, the handler reads. */
export interface AppNodeRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  /** A body parser's result. A Buffer or a string is used as the raw body. */
  body?: unknown;
  readable?: boolean;
  readableEnded?: boolean;
  [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
}

/** The third argument a Cloudflare Worker's `fetch` gets. */
export interface AppWaitUntil {
  waitUntil?: (promise: Promise<unknown>) => void;
}

/** The part of a Fastify request the plugin reads. */
export interface AppFastifyRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

/** The part of a Fastify reply the plugin writes. */
export interface AppFastifyReply {
  code(status: number): AppFastifyReply;
  headers(values: Record<string, string>): AppFastifyReply;
  send(body: string): unknown;
}

/** The part of a Fastify instance the plugin uses. */
export interface AppFastifyInstance {
  removeAllContentTypeParsers(): unknown;
  addContentTypeParser(
    type: string,
    options: { parseAs: 'buffer' },
    parser: (request: never, body: Buffer, done: (error: Error | null, body?: unknown) => void) => void,
  ): unknown;
  route(options: {
    method: string[];
    url: string;
    handler: (request: AppFastifyRequest, reply: AppFastifyReply) => Promise<unknown>;
  }): unknown;
}

/** `answers.fastify`, a Fastify plugin. Register it with `{ path }`. */
export type AppFastifyPlugin = (instance: AppFastifyInstance, options: { path?: string }, done: (error?: Error) => void) => void;

/** The function `on` takes for `kind`, typed by the kind when Siren names it in {@link AppFeatureFunctions}. */
export type AppFunctionFor<K extends string> = K extends keyof AppFeatureFunctions ? AppFeatureFunctions[K] : AppRequestFunction;

/**
 * The handler `apps.requestHandler()` answers. Mount it as it is:
 *
 * ```ts
 * http.createServer(answers)                                             // node:http
 * app.post('/siren', express.raw({ type: 'application/json' }), answers) // Express, Connect
 * fastify.register(answers.fastify, { path: '/siren' })                  // Fastify
 * export const POST = answers                                            // Next.js app route
 * export default { fetch: answers }                                      // Workers, Bun, Deno, Hono
 * const reply = await answers.handle({ method, headers, rawBody })      // anything else
 * ```
 *
 * Called with Node's `(req, res)` it writes the reply. Called with a Web
 * `Request` it answers a `Response`, and takes `ctx.waitUntil` from its
 * third argument.
 */
export interface AppRequestHandler {
  (request: Request, env?: unknown, ctx?: AppWaitUntil): Promise<Response>;
  (req: AppNodeRequest, res: NodeResponseLike, next?: unknown): Promise<void>;
  /**
   * Hands the requests for one feature, by kind and key, to `fn`. A tell's
   * `fn` returns nothing, and the reply waits for it. An ask's `fn` returns
   * the answer, which the handler posts after a 200, or `undefined` when
   * the app answers later. Refuses a feature already handled. Chainable.
   */
  on<K extends string>(kind: K, key: string, fn: AppFunctionFor<K>): AppRequestHandler;
  /** Hands the requests for every feature of `kind` that no `on(kind, key, fn)` names to `fn`. Chainable. */
  on<K extends string>(kind: K, fn: AppFunctionFor<K>): AppRequestHandler;
  /** Hands a webhook event of `type`, sent to the same address, to `fn`. Refuses a type already handled. Chainable. */
  onEvent(type: string, fn: AppEventFunction): AppRequestHandler;
  /** Serves one request for any other server. Send the reply, then run `after` when it is there. */
  handle(input: AppRequestInput): Promise<AppRequestReply>;
  /** A Fastify plugin with its own raw body parser, scoped to the plugin. */
  readonly fastify: AppFastifyPlugin;
}

/** A body the handler cannot check. */
const UNREADABLE = Symbol('unreadable');
/** A body past {@link APP_REQUEST_BODY_LIMIT}. */
const TOO_LARGE = Symbol('too large');

type Body = string | Uint8Array | typeof UNREADABLE | typeof TOO_LARGE;

interface HandlerSettings {
  secret: string;
  tolerance: number;
  maxAnswerBytes: number;
  runLater: ((work: () => Promise<void>) => void) | undefined;
  onError: (error: unknown, request?: AppRequest | WebhookEvent) => void;
}

/**
 * Builds the handler. Refuses with `SirenError` options that are not an
 * object, a missing or empty secret, a tolerance outside 1 to 3600, and a
 * `runLater` or `onError` that is not a function.
 *
 * @internal
 */
export function createAppRequestHandler(
  http: Pick<HttpTransport, 'request'>,
  options: AppRequestHandlerOptions,
  defaults: { toleranceSeconds: number; maxAnswerBytes: number },
): AppRequestHandler {
  const method = 'apps.requestHandler()';
  if (!isJsonObject(options)) {
    throw new SirenError(`${method} takes its options as an object, such as { signingSecret: process.env.SIREN_SIGNING_SECRET }.`);
  }
  const { signingSecret, toleranceSeconds, runLater, onError } = options;
  if (typeof signingSecret !== 'string' || signingSecret === '') {
    throw new SirenError(`${method} needs the app's signing secret as signingSecret, which Siren showed when it made the app's address.`);
  }
  const tolerance = toleranceSeconds ?? defaults.toleranceSeconds;
  if (!Number.isInteger(tolerance) || tolerance < 1 || tolerance > MAX_TOLERANCE_SECONDS) {
    throw new SirenError(`${method} takes toleranceSeconds as a whole number from 1 to ${MAX_TOLERANCE_SECONDS}.`);
  }
  if (runLater !== undefined && typeof runLater !== 'function') {
    throw new SirenError(`${method} takes runLater as a function that is handed the work, such as Next.js's after.`);
  }
  if (onError !== undefined && typeof onError !== 'function') {
    throw new SirenError(`${method} takes onError as a function of the error and the request.`);
  }
  const settings: HandlerSettings = {
    secret: signingSecret,
    tolerance,
    maxAnswerBytes: defaults.maxAnswerBytes,
    runLater,
    onError: onError ?? defaultOnError,
  };

  const features = new Map<string, AppRequestFunction>();
  const kinds = new Map<string, AppRequestFunction>();
  const events = new Map<string, AppEventFunction>();

  const report = (error: unknown, request?: AppRequest | WebhookEvent): void => {
    try {
      settings.onError(error, request);
    } catch {
      // An onError that throws must not take the reply or the process with it.
    }
  };

  const respond = async (verb: string | undefined, headers: WebhookHeaders, read: () => Promise<Body>): Promise<AppRequestReply> => {
    if ((verb ?? 'POST').toUpperCase() !== 'POST') {
      return reply(405, { error: 'Siren sends app requests and events with POST.' }, { Allow: 'POST' });
    }
    const raw = await read();
    if (raw === TOO_LARGE) {
      return reply(413, { error: `The request body is over ${APP_REQUEST_BODY_LIMIT} bytes, more than Siren sends.` });
    }
    if (raw === UNREADABLE) {
      report(new SirenError(PARSED_BODY));
      return reply(500, { error: PARSED_BODY });
    }

    let checked: { t: number; bytes: Buffer };
    try {
      checked = checkSignedDelivery(raw, headers, settings.secret, settings.tolerance, Date.now() / 1000);
    } catch (error) {
      if (error instanceof SignatureVerificationError) return reply(401, { error: error.message });
      throw error;
    }

    const event = readHeader(headers, 'X-Siren-Event');
    if (event === undefined || event === 'app.request') return serveRequest(checked, headers);
    return serveEvent(checked.bytes, headers);
  };

  const serveRequest = async ({ t, bytes }: { t: number; bytes: Buffer }, headers: WebhookHeaders): Promise<AppRequestReply> => {
    let request: AppRequest;
    try {
      request = appRequestFrom(bytes, t, headers);
    } catch (error) {
      if (error instanceof SignatureVerificationError) return reply(400, { error: error.message });
      throw error;
    }
    const { kind, key } = request.item;
    const fn = features.get(featureKey(kind, key)) ?? kinds.get(kind);
    if (fn === undefined) return reply(404, { error: `No function handles ${kind} ${key}.` });

    if (request.mode === 'tell') {
      try {
        await fn(request);
      } catch (error) {
        report(error, request);
        return reply(500, { error: `The function for ${kind} ${key} failed, so Siren will send this request again.` });
      }
      return reply(200, {});
    }

    const asked = request;
    const after = async (): Promise<void> => {
      try {
        const answer = await fn(asked);
        if (answer === undefined) return;
        await answerAppRequest(http, asked.id, answer as never, settings.maxAnswerBytes, true);
      } catch (error) {
        report(error, asked);
      }
    };
    return { ...reply(200, {}), after };
  };

  const serveEvent = async (bytes: Buffer, headers: WebhookHeaders): Promise<AppRequestReply> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      return reply(400, { error: 'The signed body is not JSON.' });
    }
    const event = isJsonObject(parsed) ? webhookEventFrom(parsed, headers) : undefined;
    if (event === undefined) return reply(400, { error: 'The signed body is not a JSON object.' });
    const fn = events.get(event.type);
    if (fn === undefined) return reply(200, {});
    try {
      await fn(event);
    } catch (error) {
      report(error, event);
      return reply(500, { error: `The function for ${event.type} failed, so Siren will send this event again.` });
    }
    return reply(200, {});
  };

  /** Hands an ask's work to `runLater`, `waitUntil` or the event loop, in that order. */
  const schedule = (after: (() => Promise<void>) | undefined, waitUntil?: (promise: Promise<unknown>) => void): void => {
    if (after === undefined) return;
    try {
      if (settings.runLater !== undefined) settings.runLater(after);
      else if (waitUntil !== undefined) waitUntil(after());
      else setTimeout(() => void after(), 0);
    } catch (error) {
      report(error);
    }
  };

  const failed = (error: unknown): AppRequestReply => {
    report(error);
    return reply(500, { error: 'The Siren handler failed. Siren will send this request again.' });
  };

  const handler = async (first: unknown, second?: unknown, third?: unknown): Promise<Response | void> => {
    if (isWebRequest(first)) {
      const result = await respond(first.method, first.headers, () => webBody(first)).catch(failed);
      const ctx = third as AppWaitUntil | undefined;
      const waitUntil = typeof ctx?.waitUntil === 'function' ? ctx.waitUntil.bind(ctx) : undefined;
      schedule(result.after, waitUntil);
      return new Response(result.body, { status: result.status, headers: result.headers });
    }
    const req = first as AppNodeRequest;
    const res = second as NodeResponseLike;
    const result = await respond(req.method, req.headers, () => nodeBody(req)).catch(failed);
    res.statusCode = result.status;
    for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
    res.end(result.body);
    schedule(result.after);
  };

  const fastify: AppFastifyPlugin = (instance, pluginOptions, done) => {
    try {
      instance.removeAllContentTypeParsers();
      instance.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, parsed) => parsed(null, body));
      instance.route({
        method: ['DELETE', 'GET', 'PATCH', 'POST', 'PUT', 'OPTIONS'],
        url: pluginOptions?.path ?? '/',
        handler: async (request, replyTo) => {
          const body = request.body;
          const result = await respond(request.method, request.headers, async () =>
            body === undefined ? new Uint8Array(0) : typeof body === 'string' || body instanceof Uint8Array ? body : UNREADABLE,
          ).catch(failed);
          replyTo.code(result.status).headers(result.headers).send(result.body);
          schedule(result.after);
          return replyTo;
        },
      });
      done();
    } catch (error) {
      done(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const api = {
    on(kind: unknown, keyOrFn: unknown, maybeFn?: unknown): AppRequestHandler {
      const wide = maybeFn === undefined && typeof keyOrFn === 'function';
      if (typeof kind !== 'string' || kind === '') {
        throw new SirenError('answers.on() takes a feature kind first, such as distributionResolver.');
      }
      if (wide) {
        if (kinds.has(kind)) throw new SirenError(`answers.on() already has a function for every ${kind}.`);
        kinds.set(kind, keyOrFn as AppRequestFunction);
        return self;
      }
      if (typeof keyOrFn !== 'string' || keyOrFn === '') {
        throw new SirenError("answers.on() takes the feature's key second, such as split-by-score, or the function alone for every key.");
      }
      if (typeof maybeFn !== 'function') {
        throw new SirenError(`answers.on() needs a function for ${kind} ${keyOrFn}.`);
      }
      const id = featureKey(kind, keyOrFn);
      if (features.has(id)) throw new SirenError(`answers.on() already has a function for ${kind} ${keyOrFn}.`);
      features.set(id, maybeFn as AppRequestFunction);
      return self;
    },
    onEvent(type: unknown, fn: unknown): AppRequestHandler {
      if (typeof type !== 'string' || type === '') {
        throw new SirenError('answers.onEvent() takes an event type first, such as conversion.approved.');
      }
      if (typeof fn !== 'function') throw new SirenError(`answers.onEvent() needs a function for ${type}.`);
      if (events.has(type)) throw new SirenError(`answers.onEvent() already has a function for ${type}.`);
      events.set(type, fn as AppEventFunction);
      return self;
    },
    handle(input: AppRequestInput): Promise<AppRequestReply> {
      if (!isJsonObject(input)) {
        throw new SirenError('answers.handle() takes { method, headers, rawBody }.');
      }
      const raw = input.rawBody;
      return respond(input.method, input.headers, async () => (typeof raw === 'string' || raw instanceof Uint8Array ? raw : UNREADABLE));
    },
    fastify,
  };
  const self = Object.assign(handler, api) as unknown as AppRequestHandler;
  return self;
}

function defaultOnError(error: unknown, request?: AppRequest | WebhookEvent): void {
  if (request === undefined) console.error(error);
  else console.error(error, request);
}

function featureKey(kind: string, key: string): string {
  return `${kind}\u0000${key}`;
}

function reply(status: number, body: Record<string, unknown>, extra: Record<string, string> = {}): AppRequestReply {
  return { status, headers: { ...REPLY_HEADERS, ...extra }, body: JSON.stringify(body) };
}

/** Whether the handler was given a Web `Request`. */
function isWebRequest(value: unknown): value is Request {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { url?: unknown }).url === 'string' &&
    typeof (value as { arrayBuffer?: unknown }).arrayBuffer === 'function' &&
    typeof (value as { headers?: { get?: unknown } }).headers?.get === 'function'
  );
}

/** A Web request's bytes, or UNREADABLE when something already read them. */
async function webBody(request: Request): Promise<Body> {
  if (request.bodyUsed) return UNREADABLE;
  const bytes = new Uint8Array(await request.arrayBuffer());
  return bytes.byteLength > APP_REQUEST_BODY_LIMIT ? TOO_LARGE : bytes;
}

/**
 * A Node request's bytes: a Buffer or string a raw parser left in
 * `req.body`, or the stream read here when nothing has read it. Anything
 * else, such as the object express.json() leaves, is UNREADABLE.
 */
async function nodeBody(req: AppNodeRequest): Promise<Body> {
  const body = req.body;
  if (typeof body === 'string' || body instanceof Uint8Array) return body;
  const unread = typeof req[Symbol.asyncIterator] === 'function' && req.readableEnded !== true && req.readable !== false;
  if (!unread) return UNREADABLE;
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Past the limit the rest is read and dropped, so the reply reaches a client still sending.
  for await (const chunk of req as AsyncIterable<unknown>) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Uint8Array);
    size += bytes.byteLength;
    if (size <= APP_REQUEST_BODY_LIMIT) chunks.push(bytes);
  }
  return size > APP_REQUEST_BODY_LIMIT ? TOO_LARGE : Buffer.concat(chunks);
}
