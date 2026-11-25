import { AppHandlerError, AppSlowTellError, SignatureVerificationError, SirenError, ValidationError } from '../errors';
import type { HttpTransport } from '../http';
import type { FeatureAnswers, FeatureKind, FeatureTells } from '../feature-kind';
import type { AppAnswerLater, AppAsk, AppEventFunction, AppFeatureFunctions, AppRequest, AppRequestFunction } from '../record-types';
import type { AppTestRequest } from '../testing';
import { sirenAnswerProblem } from './app-answer-rules';
import { featureKindProblem } from './app-feature-kinds';
import type { WebhookEvent, WebhookHeaders } from '../types';
import type { NodeResponseLike } from './events';
import { readEnvironment } from '../environment';
import { answerAppRequest, appRequestFrom, checkedAnswer, checkSignedDelivery, httpOrigin, MAX_TOLERANCE_SECONDS } from './app-requests';
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

/**
 * How long Siren waits for a reply before it counts a timeout: the
 * 8-second limit its delivery client puts on every post to an app's address
 * (WebhookDeliveryService::deliver(), through GuardedCurlHttpClient). A
 * tell's or a webhook event's reply waits for its function, so a function
 * slower than this runs, replies to no one, and runs again when Siren sends
 * the tell or event again.
 */
export const TELL_TIME_LIMIT_SECONDS = 8;

/** Refused signatures the default writes in one minute before it only counts them. */
const SIGNATURE_LINES_PER_MINUTE = 5;

/**
 * Where the handler writes. `console`, a pino logger and a winston logger
 * all fit. Each method gets one line.
 */
export interface AppLogger {
  /** One line per request handled: its name, the reply's status and the time it took. */
  debug(message: string): void;
  info(message: string): void;
  /** A refused signature, and a tell or event that ran past Siren's 8 seconds. */
  warn(message: string): void;
  /** Every other failure `onError` gets. */
  error(message: string): void;
}

/**
 * The logger the handler uses when you give none: warnings and errors go to
 * `console.warn` and `console.error`, and the debug line per request is
 * left out, so a production log stays quiet. Pass `logger: console` to see
 * each request.
 */
const QUIET_CONSOLE: AppLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

/** What the handler answers when a body parser already read the body. */
const PARSED_BODY =
  'The request body was already parsed, so its signature cannot be checked. ' +
  'Mount the Siren handler before the JSON body parser, or give its route a raw body, ' +
  "such as express.raw({ type: 'application/json' }).";

const REPLY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

/**
 * Options for `apps.requestHandler()`. `X` is the kinds `extraKinds`
 * names, which `on()` then takes too.
 */
export interface AppRequestHandlerOptions<X extends string = never> {
  /**
   * The app's signing secret, which Siren showed when it made the app's
   * address. Left out, the handler reads `SIREN_SIGNING_SECRET` from the
   * environment, and refuses when that is unset or empty too.
   */
  signingSecret?: string | undefined;
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
   * an answer that broke the rules, Siren's refusal of an answer, a body a
   * parser already read, a refused signature (`SignatureVerificationError`,
   * still answered 401) and a tell or event slower than Siren's 8 seconds
   * (`AppSlowTellError`). `request` is the checked request or event, when
   * there is one. The default writes one line through `logger` with the
   * kind, key and request id (or the event's type and delivery id) and the
   * error, never the request's data or headers. A stack trace follows only
   * when your own function threw. For an ask that failed after its 200, the
   * line also says when Siren sends it again and how to resend it sooner,
   * before the error. A refused signature names what to check, such as
   * `SIREN_SIGNING_SECRET`, and after five in a minute the rest are counted
   * into one line.
   */
  onError?: (error: unknown, request?: AppRequest | WebhookEvent) => void;
  /**
   * Where the default `onError` writes, and where the handler writes one
   * `debug` line per request it handled. Anything with `debug`, `info`,
   * `warn` and `error` fits: `console`, pino or winston. Refused signatures
   * and slow tells go to `warn`, and every other failure to `error`. Left
   * out, warnings and errors go to the console and the debug lines are
   * dropped.
   */
  logger?: AppLogger;
  /**
   * Kinds a newer Siren sends that this SDK does not know yet, which `on()`
   * then takes. `on()` refuses any other kind Siren never sends.
   */
  extraKinds?: readonly X[];
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
 * What `simulate()` answers, the same four fields in the PHP and Python
 * SDKs: the reply's status, its body parsed, the answer the handler would
 * post, and the error `onError` would get. `A` is the kind's answer type
 * when the request came from `appRequest()`.
 */
export interface AppSimulation<A = unknown> {
  status: number;
  body: Record<string, unknown>;
  /**
   * The answer an ask's function returned, once it passed the post's check
   * and Siren's answer rules for the kind. Null for a tell, after
   * `answers.later()`, beside a refused answer, and on any error.
   */
  answer: A | null;
  /**
   * What `onError` would get, or null: a function that threw or returned
   * nothing (`AppHandlerError`), an answer the post would refuse, an answer
   * Siren's answer route would refuse (a `ValidationError` with code
   * `app_answer_invalid` and Siren's words), or an answer address on another
   * Siren. `simulate()` never throws for a function's failure.
   */
  error: unknown;
}

/** The answer type `simulate()` gives a request `appRequest()` built for `K`: the kind's answer, `never` for a tell, and `unknown` for a kind this SDK doesn't know. */
export type AppSimulatedAnswer<K extends string> = K extends keyof FeatureAnswers ? FeatureAnswers[K] : K extends keyof FeatureTells ? never : unknown;

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

/**
 * The function `on` takes for `kind`, typed by the kind when Siren sends it
 * ({@link AppFeatureFunctions}). `customEvent` is a {@link FeatureKind} that
 * Siren never sends, so no function fits it, and `on()` refuses it at run
 * time too. A kind `extraKinds` names takes an {@link AppRequestFunction}.
 */
export type AppFunctionFor<K extends string> = K extends keyof AppFeatureFunctions
  ? AppFeatureFunctions[K]
  : K extends FeatureKind
    ? never
    : AppRequestFunction;

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
 * third argument. `X` is the kinds the `extraKinds` option names: the
 * handler `apps.requestHandler()` answers without them is
 * {@link AppRequestHandler}.
 */
export interface AppRequestHandlerWith<X extends string> {
  (req: AppNodeRequest, res: NodeResponseLike, next?: unknown): Promise<void>;
  // The Web signature stays last: Next.js 13 to 15 type-check a route's
  // `POST` against the last call signature (test/types/next-route.ts).
  (request: Request, env?: unknown, ctx?: AppWaitUntil): Promise<Response>;
  /**
   * Hands the requests for one feature, by kind and key, to `fn`. A tell's
   * `fn` returns nothing, and the reply waits for it. An ask's `fn` returns
   * the answer, which the handler posts after a 200, or `answers.later()`
   * when the app answers later. An ask's `fn` that returns nothing is an
   * error, which `onError` gets. Refuses a kind Siren never sends, saying
   * what to write instead, and a feature already handled. Chainable.
   */
  on<K extends FeatureKind | X>(kind: K, key: string, fn: AppFunctionFor<K>): this;
  /** Hands the requests for every feature of `kind` that no `on(kind, key, fn)` names to `fn`. Chainable. */
  on<K extends FeatureKind | X>(kind: K, fn: AppFunctionFor<K>): this;
  /** Hands a webhook event of `type`, sent to the same address, to `fn`. Refuses a type already handled. Chainable. */
  onEvent(type: string, fn: AppEventFunction): this;
  /**
   * What an ask's function returns when the app will answer later with
   * `apps.requests.answer()`. The handler then posts nothing and reports
   * nothing. Always the same value.
   */
  later(): AppAnswerLater;
  /** Serves one request for any other server. Send the reply, then run `after` when it is there. */
  handle(input: AppRequestInput): Promise<AppRequestReply>;
  /**
   * Runs the whole handler on one request, as `handle()` does, but posts
   * nothing and calls no `onError`. An ask's function runs at once, and its
   * answer gets the check the post would give it, then the checks Siren's
   * answer route runs for the kind. For tests, with `appRequest()` from
   * `@novatorius/siren/testing`, which types the answer by the kind.
   */
  simulate<K extends string>(input: AppTestRequest<K>): Promise<AppSimulation<AppSimulatedAnswer<K>>>;
  /** Runs the whole handler on any signed request, as above. The answer is untyped. */
  simulate(input: AppRequestInput): Promise<AppSimulation>;
  /** A Fastify plugin with its own raw body parser, scoped to the plugin. */
  readonly fastify: AppFastifyPlugin;
}

/**
 * The handler `apps.requestHandler()` answers. `on()` takes every kind
 * Siren sends, and its function's request and answer are typed by the
 * kind. See {@link AppRequestHandlerWith} for mounting it.
 */
export interface AppRequestHandler extends AppRequestHandlerWith<never> {}

/** A body the handler cannot check. */
const UNREADABLE = Symbol('unreadable');
/** A body past {@link APP_REQUEST_BODY_LIMIT}. */
const TOO_LARGE = Symbol('too large');

type Body = string | Uint8Array | typeof UNREADABLE | typeof TOO_LARGE;

interface HandlerSettings {
  secret: string;
  /** The client's base address, the only place an answer is posted. */
  base: string;
  tolerance: number;
  maxAnswerBytes: number;
  runLater: ((work: () => Promise<void>) => void) | undefined;
  /** The caller's onError, or undefined for the default line. */
  onError: ((error: unknown, request?: AppRequest | WebhookEvent) => void) | undefined;
  logger: AppLogger;
}

/** What a failure is, for the default line's level and words. */
type Failure = 'error' | 'after-reply' | 'signature';

/** The request or event `respond()` read, for the debug line. */
interface Seen {
  request?: AppRequest | WebhookEvent;
}

/** `answers.later()`: one frozen value for every handler. */
const LATER = Object.freeze({}) as AppAnswerLater;

/** What a simulated request collects instead of posting or calling onError. */
interface Simulation {
  answer: unknown;
  error: unknown;
}

/**
 * Siren Cloud's two public hosts, which count as one Siren. Cloud builds
 * `answerUrl` from its `APP_URL`, and the SDK's default base is the api
 * host. Siren's own records put both hosts on one service:
 * .github/workflows/deploy-cloud.yml checks health at
 * https://app.sirenaffiliates.com/health,
 * .github/workflows/publish-product-screenshots.yml sets
 * APP_URL=https://app.sirenaffiliates.com, and docs/origin-lock-runbook.md
 * has Cloudflare proxy both hosts to the same origin, where nginx answers
 * with `server_name _`. Every other origin difference fails, and the answer
 * still goes only to the client's base.
 */
const CLOUD_ORIGINS: readonly string[] = ['https://api.sirenaffiliates.com', 'https://app.sirenaffiliates.com'];

/** Whether two origins are the same Siren. */
function sameSiren(a: string, b: string): boolean {
  return a === b || (CLOUD_ORIGINS.includes(a) && CLOUD_ORIGINS.includes(b));
}

/**
 * Builds the handler. Refuses with `SirenError` options that are not an
 * object, a missing or empty secret, a tolerance outside 1 to 3600, and a
 * `runLater` or `onError` that is not a function.
 *
 * @internal
 */
export function createAppRequestHandler<X extends string = never>(
  http: Pick<HttpTransport, 'request' | 'urlFor'>,
  options: AppRequestHandlerOptions<X> = {},
  defaults: { toleranceSeconds: number; maxAnswerBytes: number },
): AppRequestHandlerWith<X> {
  const method = 'apps.requestHandler()';
  if (!isJsonObject(options)) {
    throw new SirenError(`${method} takes its options as an object, such as { signingSecret: process.env.SIREN_SIGNING_SECRET }.`);
  }
  const given: AppRequestHandlerOptions<X> = options;
  const { toleranceSeconds, runLater, onError, extraKinds, logger } = given;
  const signingSecret = given.signingSecret === undefined ? readEnvironment('SIREN_SIGNING_SECRET') : given.signingSecret;
  if (typeof signingSecret !== 'string' || signingSecret === '') {
    throw new SirenError(
      `${method} needs the app's signing secret, which Siren showed when it made the app's address. Pass it as signingSecret, or set SIREN_SIGNING_SECRET in the environment.`,
    );
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
  if (
    logger !== undefined &&
    (typeof logger !== 'object' || logger === null || !['debug', 'info', 'warn', 'error'].every((level) => typeof (logger as unknown as Record<string, unknown>)[level] === 'function'))
  ) {
    throw new SirenError(`${method} takes logger as an object with debug, info, warn and error functions, such as console or a pino logger.`);
  }
  if (extraKinds !== undefined && (!Array.isArray(extraKinds) || !extraKinds.every((kind) => typeof kind === 'string' && kind !== ''))) {
    throw new SirenError(`${method} takes extraKinds as a list of kind names, such as ['brandNewKind'].`);
  }
  const extra: ReadonlySet<string> = new Set(extraKinds ?? []);
  const settings: HandlerSettings = {
    secret: signingSecret,
    base: http.urlFor(''),
    tolerance,
    maxAnswerBytes: defaults.maxAnswerBytes,
    runLater,
    onError,
    logger: logger ?? QUIET_CONSOLE,
  };

  const features = new Map<string, AppRequestFunction>();
  const kinds = new Map<string, AppRequestFunction>();
  const events = new Map<string, AppEventFunction>();

  /** Errors the app's own functions threw, which alone get a stack trace in the default line. */
  const thrownByApp = new WeakSet<object>();
  /** Runs an app's function, marking what it throws as its own. */
  const run = async <T>(work: () => T | Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (typeof error === 'object' && error !== null) thrownByApp.add(error);
      throw error;
    }
  };

  /** The refused signatures of the current minute, for the default's flood control. */
  const refusals = { since: Number.NaN, written: 0, counted: 0 };

  const refusedSignature = (error: unknown): void => {
    const now = Date.now();
    if (!(now - refusals.since < 60_000)) {
      if (refusals.counted > 0) {
        const n = refusals.counted;
        settings.logger.warn(
          `${n} more ${n === 1 ? 'request' : 'requests'} failed the signature check in the last minute. When every request fails, SIREN_SIGNING_SECRET is wrong or was rotated.`,
        );
      }
      refusals.since = now;
      refusals.written = 0;
      refusals.counted = 0;
    }
    if (refusals.written >= SIGNATURE_LINES_PER_MINUTE) {
      refusals.counted += 1;
      return;
    }
    refusals.written += 1;
    const message = error instanceof Error ? error.message : String(error);
    const hint = SIGNATURE_HINTS[(error as SirenError).code ?? ''];
    settings.logger.warn(`Siren request handler: refused a request with 401. ${message}${hint === undefined ? '' : ` ${hint}`}`);
  };

  /** The default onError: one line through the logger, at the failure's level. */
  const defaultOnError = (error: unknown, request: AppRequest | WebhookEvent | undefined, failure: Failure): void => {
    if (failure === 'signature') {
      refusedSignature(error);
      return;
    }
    const prefix = `Siren request handler${describeRequest(request)}:`;
    let text = errorText(error);
    if (typeof error === 'object' && error !== null && thrownByApp.has(error)) text += stackOf(error);
    if (error instanceof AppSlowTellError) {
      settings.logger.warn(`${prefix} ${text}`);
      return;
    }
    if (failure === 'after-reply' && request !== undefined && 'feature' in request && request.mode === 'ask' && !settled(error)) {
      settings.logger.error(`${prefix} ${brokeSirensRule(error) ? brokenRule(request) : nextSend(request)} ${text}`);
      return;
    }
    settings.logger.error(`${prefix} ${text}`);
  };

  /**
   * Hands an error to onError, or writes the default line. `failure` is
   * `after-reply` for an ask's work after its 200, so the default line says
   * when Siren sends the ask again, and `signature` for a refused signature.
   */
  const report = (error: unknown, request?: AppRequest | WebhookEvent, failure: Failure = 'error'): void => {
    try {
      if (settings.onError !== undefined) settings.onError(error, request);
      else defaultOnError(error, request, failure);
    } catch {
      // An onError or a logger that throws must not take the reply or the process with it.
    }
  };

  /** Serves one request, then writes its debug line. `simulate()` writes none. */
  const respond = async (
    verb: string | undefined,
    headers: WebhookHeaders,
    read: () => Promise<Body>,
    sim?: Simulation,
  ): Promise<AppRequestReply> => {
    const started = Date.now();
    const seen: Seen = {};
    const result = await serve(verb, headers, read, seen, sim);
    if (sim === undefined) {
      try {
        settings.logger.debug(`Siren request handler${describeRequest(seen.request)}: ${result.status} in ${Date.now() - started} ms`);
      } catch {
        // A logger that throws must not take the reply with it.
      }
    }
    return result;
  };

  const serve = async (
    verb: string | undefined,
    headers: WebhookHeaders,
    read: () => Promise<Body>,
    seen: Seen,
    sim?: Simulation,
  ): Promise<AppRequestReply> => {
    const note = (error: unknown, request?: AppRequest | WebhookEvent, failure: Failure = 'error'): void => {
      if (sim === undefined) report(error, request, failure);
      else sim.error = error;
    };
    if ((verb ?? 'POST').toUpperCase() !== 'POST') {
      return reply(405, { error: 'Siren sends app requests and events with POST.' }, { Allow: 'POST' });
    }
    const raw = await read();
    if (raw === TOO_LARGE) {
      return reply(413, { error: `The request body is over ${APP_REQUEST_BODY_LIMIT} bytes, more than Siren sends.` });
    }
    if (raw === UNREADABLE) {
      note(new SirenError(PARSED_BODY));
      return reply(500, { error: PARSED_BODY });
    }

    let checked: { t: number; bytes: Buffer };
    try {
      checked = checkSignedDelivery(raw, headers, settings.secret, settings.tolerance, Date.now() / 1000);
    } catch (error) {
      if (error instanceof SignatureVerificationError) {
        note(error, undefined, 'signature');
        return reply(401, { error: error.message });
      }
      throw error;
    }

    const event = readHeader(headers, 'X-Siren-Event');
    if (event === undefined || event === 'app.request') return serveRequest(checked, headers, note, seen, sim);
    return serveEvent(checked.bytes, headers, note, seen);
  };

  const serveRequest = async (
    { t, bytes }: { t: number; bytes: Buffer },
    headers: WebhookHeaders,
    note: (error: unknown, request?: AppRequest | WebhookEvent) => void,
    seen: Seen,
    sim: Simulation | undefined,
  ): Promise<AppRequestReply> => {
    let request: AppRequest;
    try {
      request = appRequestFrom(bytes, t, headers);
    } catch (error) {
      if (error instanceof SignatureVerificationError) return reply(400, { error: error.message });
      throw error;
    }
    seen.request = request;
    const { kind, key } = request.feature;
    const fn = features.get(featureKey(kind, key)) ?? kinds.get(kind);
    if (fn === undefined) return reply(404, { error: `No function handles ${kind} ${key}.` });

    if (request.mode === 'tell') {
      const started = Date.now();
      try {
        await run(() => fn(request));
      } catch (error) {
        note(error, request);
        return reply(500, { error: `The function for ${kind} ${key} failed, so Siren will send this request again.` });
      }
      checkTime(started, `${kind} ${key}`, 'tell', request, note);
      return reply(200, {});
    }

    const asked = request;
    const elsewhere = otherSiren(asked.answerUrl ?? '');
    if (elsewhere !== undefined) {
      note(new SirenError(elsewhere), asked);
      return reply(500, { error: elsewhere });
    }
    if (sim !== undefined) {
      try {
        const answer = givenAnswer(await run(() => fn(asked)), asked);
        if (answer !== LATER) {
          simulatedAnswer(answer, asked);
          sim.answer = answer;
        }
      } catch (error) {
        sim.error = error;
      }
      return reply(200, {});
    }
    const after = async (): Promise<void> => {
      try {
        const answer = givenAnswer(await run(() => fn(asked)), asked);
        if (answer === LATER) return;
        await answerAppRequest(http, asked.id, answer as never, settings.maxAnswerBytes, true);
      } catch (error) {
        report(error, asked, 'after-reply');
      }
    };
    return { ...reply(200, {}), after };
  };

  /**
   * Checks an answer as the post would, then as Siren's answer route would
   * for its kind, and throws `ValidationError` with Siren's code and words
   * for an answer Siren refuses. Only `simulate()` runs Siren's checks.
   */
  const simulatedAnswer = (answer: unknown, asked: AppAsk): void => {
    const copy = checkedAnswer(answer, settings.maxAnswerBytes, 'answers.simulate()');
    const sent = JSON.parse(JSON.stringify(copy)) as Record<string, unknown>;
    const problem = sirenAnswerProblem(asked.feature.kind, isJsonObject(asked.data) ? asked.data : {}, sent);
    if (problem !== undefined) throw new ValidationError(problem, { code: 'app_answer_invalid', statusCode: 422 });
  };

  /**
   * The words for an answer address on another Siren than the client's
   * base, or undefined when they are the same Siren. The handler never
   * posts to the request's address, so the key goes only to the base.
   */
  const otherSiren = (answerUrl: string): string | undefined => {
    const asked = httpOrigin(answerUrl);
    const ours = httpOrigin(settings.base);
    if (asked !== undefined && ours !== undefined && sameSiren(asked, ours)) return undefined;
    const suggested = answerUrl.replace(/\/apps\/requests\/[^/]+\/answer$/, '');
    return (
      `Siren sent this request from ${answerUrl}, but this client sends answers to ${settings.base}. ` +
      `Set baseUrl to ${suggested} when you build the client.`
    );
  };

  const serveEvent = async (
    bytes: Buffer,
    headers: WebhookHeaders,
    note: (error: unknown, request?: AppRequest | WebhookEvent) => void,
    seen: Seen,
  ): Promise<AppRequestReply> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      return reply(400, { error: 'The signed body is not JSON.' });
    }
    const event = isJsonObject(parsed) ? webhookEventFrom(parsed, headers) : undefined;
    if (event === undefined) return reply(400, { error: 'The signed body is not a JSON object.' });
    seen.request = event;
    const fn = events.get(event.type);
    if (fn === undefined) return reply(200, {});
    const started = Date.now();
    try {
      await run(() => fn(event));
    } catch (error) {
      note(error, event);
      return reply(500, { error: `The function for ${event.type} failed, so Siren will send this event again.` });
    }
    checkTime(started, event.type, 'event', event, note);
    return reply(200, {});
  };

  /**
   * Reports a tell or an event whose function ran past
   * {@link TELL_TIME_LIMIT_SECONDS}: its reply came after Siren stopped
   * waiting, so Siren sends it again and the function runs twice.
   */
  const checkTime = (
    started: number,
    name: string,
    what: 'tell' | 'event',
    about: AppRequest | WebhookEvent,
    note: (error: unknown, request?: AppRequest | WebhookEvent) => void,
  ): void => {
    const took = Date.now() - started;
    if (took <= TELL_TIME_LIMIT_SECONDS * 1000) return;
    note(
      new AppSlowTellError(
        `${name} took ${(took / 1000).toFixed(1)} s. Siren stops waiting at ${TELL_TIME_LIMIT_SECONDS} s and sends the ${what} again, so it ran twice. ` +
          'Save what you need, hand the slow part to runLater or your own queue, and return.',
      ),
      about,
    );
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
    on(kind: unknown, keyOrFn: unknown, maybeFn?: unknown): AppRequestHandlerWith<X> {
      const wide = maybeFn === undefined && typeof keyOrFn === 'function';
      if (typeof kind !== 'string' || kind === '') {
        throw new AppHandlerError('answers.on() takes a feature kind first, such as distributionResolver.');
      }
      const problem = featureKindProblem(kind, extra);
      if (problem !== undefined) throw new AppHandlerError(problem);
      if (wide) {
        if (kinds.has(kind)) throw new AppHandlerError(`answers.on() already has a function for every ${kind}.`);
        kinds.set(kind, keyOrFn as AppRequestFunction);
        return self;
      }
      if (typeof keyOrFn !== 'string' || keyOrFn === '') {
        throw new AppHandlerError("answers.on() takes the feature's key second, such as split-by-score, or the function alone for every key.");
      }
      if (typeof maybeFn !== 'function') {
        throw new AppHandlerError(`answers.on() needs a function for ${kind} ${keyOrFn}.`);
      }
      const id = featureKey(kind, keyOrFn);
      if (features.has(id)) throw new AppHandlerError(`answers.on() already has a function for ${kind} ${keyOrFn}.`);
      features.set(id, maybeFn as AppRequestFunction);
      return self;
    },
    onEvent(type: unknown, fn: unknown): AppRequestHandlerWith<X> {
      if (typeof type !== 'string' || type === '') {
        throw new AppHandlerError('answers.onEvent() takes an event type first, such as conversion.approved.');
      }
      if (typeof fn !== 'function') throw new AppHandlerError(`answers.onEvent() needs a function for ${type}.`);
      if (events.has(type)) throw new AppHandlerError(`answers.onEvent() already has a function for ${type}.`);
      events.set(type, fn as AppEventFunction);
      return self;
    },
    later(): AppAnswerLater {
      return LATER;
    },
    handle(input: AppRequestInput): Promise<AppRequestReply> {
      if (!isJsonObject(input)) {
        throw new AppHandlerError('answers.handle() takes { method, headers, rawBody }.');
      }
      const raw = input.rawBody;
      return respond(input.method, input.headers, async () => (typeof raw === 'string' || raw instanceof Uint8Array ? raw : UNREADABLE));
    },
    async simulate(input: AppRequestInput): Promise<AppSimulation> {
      if (!isJsonObject(input)) {
        throw new AppHandlerError('answers.simulate() takes { method, headers, rawBody }, such as appRequest() from @novatorius/siren/testing answers.');
      }
      const raw = input.rawBody;
      const sim: Simulation = { answer: null, error: null };
      const result = await respond(
        input.method,
        input.headers,
        async () => (typeof raw === 'string' || raw instanceof Uint8Array ? raw : UNREADABLE),
        sim,
      );
      return {
        status: result.status,
        body: JSON.parse(result.body) as Record<string, unknown>,
        answer: sim.error === null ? sim.answer : null,
        error: sim.error,
      };
    },
    fastify,
  };
  const self = Object.assign(handler, api) as unknown as AppRequestHandlerWith<X>;
  return self;
}

/**
 * The answer an ask's function returned, or LATER. Nothing at all
 * (`undefined` or `null`) is an error, since an ask needs an answer.
 */
function givenAnswer(answer: unknown, asked: AppAsk): unknown {
  if (answer !== undefined && answer !== null) return answer;
  throw new AppHandlerError(
    `The function for ${asked.feature.kind} ${asked.feature.key} returned nothing. ` +
      'Return the answer, or return answers.later() when you will answer with apps.requests.answer().',
  );
}

/** What each refused signature's line adds, by the error's code. */
const SIGNATURE_HINTS: Readonly<Record<string, string>> = {
  signature_mismatch: "Check SIREN_SIGNING_SECRET: it must be this app's signing secret, and it changes when the secret is rotated.",
  signature_missing: "Check that a proxy passes Siren's X-Siren-* headers through.",
  signature_malformed: "Check that a proxy passes Siren's X-Siren-* headers through.",
  timestamp_mismatch: "Check that a proxy passes Siren's X-Siren-* headers through.",
};

/**
 * An error as one line: its class, message and code, with a cause folded in
 * as "(cause: ...)". Never its data, which can hold the app's business data.
 */
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return oneLine(String(error));
  let text = `${error.name}: ${oneLine(error.message)}`;
  const code = (error as SirenError).code;
  if (typeof code === 'string' && code !== '' && !error.message.includes(code)) text += ` (${code})`;
  const cause: unknown = error.cause;
  if (cause instanceof Error) text += ` (cause: ${oneLine(cause.message)})`;
  else if (typeof cause === 'string' && cause !== '') text += ` (cause: ${oneLine(cause)})`;
  return text;
}

/** The stack frames of an error the app's own function threw, on the lines after the first. */
function stackOf(error: object): string {
  const stack = (error as { stack?: unknown }).stack;
  if (typeof stack !== 'string') return '';
  const frames = stack.indexOf('\n    at ');
  return frames < 0 ? '' : stack.slice(frames);
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ');
}

/** Whether Siren refused the answer for breaking its rules, which a resend would only repeat. */
function brokeSirensRule(error: unknown): boolean {
  return error instanceof ValidationError && error.code === 'app_answer_invalid';
}

/** What to do after Siren refused an answer with 422 `app_answer_invalid`. */
function brokenRule(request: AppAsk): string {
  return (
    "Your function's answer broke Siren's rule. Reproduce it with simulate() on this request's data, fix it, " +
    `then resend with \`siren apps resend ${request.id}\`.`
  );
}

/**
 * Whether Siren's refusal means it sends the ask no more: 409 (another
 * answer came first, or Siren dropped the ask), 403 (the app is off) and
 * 404 (no such request for this app).
 */
function settled(error: unknown): boolean {
  return error instanceof SirenError && error.statusCode !== undefined && [403, 404, 409].includes(error.statusCode);
}

/**
 * When Siren sends a failed ask again, from its `answerBy`, and how to
 * resend it sooner: `siren apps resend` (src/cli/commands/requests.ts,
 * appsResend). Siren's resend route takes a pending ask
 * (ResendAppRequest.php), while Siren Cloud offers Send again only once
 * the ask needs attention (apps.ts resendAction()), so the line names the
 * command alone. The time is in UTC, with
 * the day when it is not today. A `answerBy` that is not a date leaves the
 * time out.
 */
function nextSend(request: AppAsk): string {
  const at = Date.parse(request.answerBy);
  let when = '';
  if (!Number.isNaN(at)) {
    const iso = new Date(at).toISOString();
    const today = new Date().toISOString().slice(0, 10);
    when = ` after ${iso.slice(11, 16)} UTC${iso.slice(0, 10) === today ? '' : ` on ${iso.slice(0, 10)}`}`;
  }
  return (
    `Siren sends it again${when === '' ? '' : `${when},`} when its answer window closes. ` +
    `Resend it sooner with \`siren apps resend ${request.id}\`.`
  );
}

/** ` (<kind> <key> <id>)` for an app request, ` (<type> <delivery id>)` for an event, and nothing without one. */
function describeRequest(request: AppRequest | WebhookEvent | undefined): string {
  if (request === undefined) return '';
  if ('feature' in request) return ` (${request.feature.kind} ${request.feature.key} ${request.id})`;
  return ` (${[request.type, request.deliveryId].filter((part) => part !== undefined).join(' ')})`;
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
