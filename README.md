# Siren SDK for Node.js

Record affiliate and incentive events, and verify signed webhooks, in a few lines of TypeScript.

[![npm version](https://img.shields.io/npm/v/@novatorius/siren.svg)](https://www.npmjs.com/package/@novatorius/siren)
[![CI](https://github.com/Novatorius/siren-node/actions/workflows/ci.yml/badge.svg)](https://github.com/Novatorius/siren-node/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/node/v/@novatorius/siren.svg)](https://www.npmjs.com/package/@novatorius/siren)

## What is Siren?

[Siren](https://sirenaffiliates.com) is headless affiliate and incentive tracking for any commerce
stack. It tracks the full lifecycle from customer interaction to payout — clicks, sales, signups,
course completions — and computes rewards from flexible rules you define. Affiliate programs,
referral programs, partner and reseller commissions, creator royalties, sales commissions, and
loyalty rewards all run on the same engine.

## What this SDK does

This SDK is the Node.js and TypeScript integration point for Siren. In a few lines you can:

- **Record events** (`events.sale`, `events.refund`, `events.siteVisited`) so conversions and
  payouts compute.
- **Verify signed webhooks** (`webhooks.constructEvent`) so you can trust inbound deliveries.
- **Read the ledger** (`conversions`, `transactions`, `obligations`, `payouts`) and **manage webhook
  subscriptions** with an API key that holds the ledger and webhook scopes.

It runs on Node 18+ with zero runtime dependencies (it uses the global `fetch`), and ships ESM,
CJS, and full type declarations.

## Install

```sh
npm install @novatorius/siren
```

## Quickstart: record a sale

Mint an API key in the Siren dashboard (Settings → API Keys), then:

```ts
import { Siren } from '@novatorius/siren';

const siren = new Siren({ apiKey: process.env.SIREN_API_KEY! });

// Record a completed sale so conversions and payouts compute.
// `total` is in MAJOR currency units: 49.99 means $49.99.
const { opportunityId } = await siren.events.sale({
  source: 'stripe',                 // your commerce source
  externalId: 'cs_test_a1b2c3',     // your order id — used to match refunds later
  total: 49.99,
  trackingId: 4021,                 // opportunity id from the Siren tracking cookie
});

console.log(`Recorded against opportunity ${opportunityId}`);
```

Each call also returns what Siren did with the event. A sale's `status` is `created`, `recorded`,
`duplicate`, `unattributed` or `ignored`, and `body` holds the full answer. While your organization's
engine is paused, Siren queues the event instead of refusing it and the result has `queued: true`.
A queued event needs no resend.

`currency` is optional and must be a currency your organization uses. Without it, the sale is
recorded in your organization's default currency.

With line items (per-unit `amount`; a missing `quantity` defaults to `1`):

```ts
await siren.events.sale({
  source: 'woocommerce',
  externalId: 'order-88',
  total: 159.97,
  trackingId: 4021,
  items: [
    { name: 'Pro Plan (annual)', amount: 49.99 },                 // quantity defaults to 1
    { externalId: 'sku-2', name: 'Add-on seat', quantity: 3, amount: 36.66 },
  ],
});
```

Give each line a `lineId`, your own id for the order line, and a later refund can name the line by
it.

To check an integration without a real order, send a test sale. It needs no other field. Siren
marks it as a test, counts it toward nothing, and ignores `trackingId`, so a real visit is never
spent. Sending the same test again reads as a pass:

```ts
const check = await siren.events.sale({ test: true });
console.log(check.body?.test); // true
```

Refunds and referred visits work the same way. A refund names the order by `externalId` and the
refund by `refundId`, your store's own id for it. Siren requires it and records each refund id once
per order:

```ts
await siren.events.refund({ source: 'stripe', externalId: 'cs_test_a1b2c3', refundId: 're_3Nf8a2' });
await siren.events.siteVisited({ collaboratorId: 88, userId: 12345 });
await siren.events.ingest('loyalty-points-earned', { userId: 42, points: 100 });
```

A refund with neither `amount` nor `lines` refunds the whole order, and `kind` (`RefundKind`) says
how the order ended: `refund`, `cancelled` or `voided`. A refund that sends `amount` or `lines`
refunds part of the order. Each line in `lines` is a `RefundLine` that names the sale's line by
`lineId`, or by `sku`. Send `whole: true` to refund the whole order whatever else you send:

```ts
import { RefundKind } from '@novatorius/siren';

await siren.events.refund({
  source: 'woocommerce',
  externalId: 'order-88',
  refundId: 2201,
  currency: 'USD',
  lines: [{ lineId: 'line-2', quantity: 1, amount: 36.66 }],
});

await siren.events.refund({
  source: 'woocommerce',
  externalId: 'order-91',
  refundId: 2207,
  kind: RefundKind.Cancelled,
});
```

A visit can name the collaborator by one of their tracking codes instead of their id, written
`tracking:{code}` (a `TrackingCodeReference`). Siren resolves the code to its collaborator:

```ts
await siren.events.siteVisited({ collaboratorId: 'tracking:summer-sale' });
```

Siren records every visit it receives, so the SDK sends `events.siteVisited` once and never retries
it. Siren has no key to match a resent custom event either, so `events.ingest` is sent once,
whatever its slug. A sale with no `externalId` is sent once too, because Siren gives a test sale
with no id a random one and refuses a real sale without one. Refunds and sales that carry an
`externalId` are retried, because Siren records a resent sale or a resent refund id once.

## Quickstart: verify a webhook

Siren signs every delivery with `X-Siren-Signature: sha256=<hmac>` — an HMAC-SHA256 of the raw
request body keyed by your subscription's signing secret. The body is the event payload itself.
The event type travels in the `X-Siren-Event` header and a unique delivery id in
`X-Siren-Delivery`. `constructEvent` verifies the signature (constant-time) and parses the event in
one call. Pass the request headers so it can fill in `type` and `deliveryId`. Without the
`X-Siren-Event` header it throws `SignatureVerificationError`, because the body alone does not name
the event. A connected site's subscription receives an envelope that names its own type and id, and
`event.body` holds the whole envelope with its `records`.

> **⚠️ You MUST pass the RAW request body bytes to `constructEvent`.**
> Body parsers like `express.json()` re-serialize the payload, and the HMAC will never match a
> re-serialized body. Use `express.raw()` (or your framework's raw-body equivalent) on the webhook
> route so you hand `constructEvent` the exact bytes Siren sent.

```ts
import express from 'express';
import { Siren, SignatureVerificationError } from '@novatorius/siren';

const siren = new Siren({ apiKey: process.env.SIREN_API_KEY! });
const app = express();

app.post('/webhooks/siren', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = siren.webhooks.constructEvent(
      req.body,                              // raw Buffer — exact bytes received
      req.header('X-Siren-Signature'),
      process.env.SIREN_WEBHOOK_SECRET!,
      req.headers,                           // gives event.type and event.deliveryId
    );
  } catch (err) {
    if (err instanceof SignatureVerificationError) {
      return res.status(400).send('invalid signature');
    }
    throw err;
  }

  // Retries can deliver the same event twice. Skip a deliveryId you already handled.
  switch (event.type) {
    case 'conversion.approved':
      // ...
      break;
    case 'payout.paid':
      // ...
      break;
  }

  res.sendStatus(200);
});
```

Create the subscription (the `signingSecret` is returned **once** — store it). The API key needs
the `webhook-subscriptions:manage` scope. Siren lists the event types it sends at
`GET /webhooks/events`, and `WebhookEventType` holds the same names:

```ts
import { WebhookEventType } from '@novatorius/siren';

const sub = await siren.webhooks.subscriptions.create({
  targetUrl: 'https://example.com/webhooks/siren',
  events: [WebhookEventType.ConversionApproved, WebhookEventType.PayoutPaid],
  // or: events: [WebhookEventType.All]
});
await saveSecretSomewhereSafe(sub.signingSecret);
```

`webhooks.subscriptions.events()` reads that live list, each entry an `event`, its `category` and a
readable `label`. It can hold an event this SDK's `WebhookEventType` lacks yet. The key needs
`webhook-subscriptions:read` or `webhook-subscriptions:manage`:

```ts
const catalog = await siren.webhooks.subscriptions.events();
// [{ event: 'sale.created', category: 'Sales', label: 'A sale was recorded' }, ...]
```

## Features

- **Event ingestion** — record sales, refunds, referred visits, and custom event types
  (`events.sale`, `events.refund`, `events.siteVisited`, `events.ingest`). Sales and refunds
  are auto-retried on network errors and 429/5xx. A visit, a custom event sent through
  `events.ingest` and a sale with no `externalId` are sent once.
- **Signed-webhook verification and subscriptions** — constant-time signature checks
  (`webhooks.constructEvent`, `webhooks.verifySignature`) plus subscription management
  (`webhooks.subscriptions.create` / `list` / `delete`) with an API key that holds a webhook scope.
- **API keys** — mint, list, and revoke keys (`apiKeys.create` / `list` / `revoke`), and list the
  scopes a new key may hold (`apiKeys.scopes()`), with a dashboard session's token. The raw key is
  returned once and cannot be retrieved later.
- **Reconciliation reads** — thin paginated readers over Siren's ledger for `conversions`,
  `transactions`, `obligations`, and `payouts`, with an API key that holds the ledger scopes.
- **Browser storefront module** — `@novatorius/siren/storefront` records referred visits and claims
  orders from a shopper's browser, and runs Siren Cloud application forms on your own site, with no
  API key and no Node built-ins.
- **Typed errors** — every failure throws a typed subclass of `SirenError` carrying `message`,
  `code`, and `statusCode` (`NotFoundError`, `RateLimitError`, `ValidationError`, and more).

```ts
const conversions = await siren.conversions.list({ page: 1, perPage: 50, status: 'approved' });
console.log(conversions.estimatedCount); // total across all pages, if known

```

Pages hold up to 200 records, and Siren's default page size is 10.

## Collaborators and programs

The client reads and writes the records a connector works with: collaborators with their codes and
program enrollments, collaborator groups with their members, programs and program groups. Each
record resource takes a dashboard session's token, or a connected site's token on the routes Siren
opens to sites.

```ts
import { CollaboratorBulkAction, Siren } from '@novatorius/siren';

// siren.collaborators: list, retrieve, create, update, delete, bulk
const active = await siren.collaborators.list({ status: 'active', perPage: 50 });
const ada = await siren.collaborators.retrieve(42, { fields: ['id', 'fullName', 'referralCode'] });
await siren.collaborators.bulk(CollaboratorBulkAction.AddToProgram, [42, 43], { programId: 7 });
```

A connected site creates a collaborator with `createPending`, which sends `fullName`, `nickname`,
`email` and an optional `trackingId` with `status: 'pending'` so the organization approves them,
and throws `SirenError` for any other field. The site changes a collaborator only with `updateDetails`, which sends
`fullName` and `nickname` and throws `SirenError` for any other key.

```ts
const pending = await siren.collaborators.createPending({
  fullName: 'Ada Lovelace',
  nickname: 'ada',
  email: 'ada@example.com',
});
await siren.collaborators.updateDetails(pending.id, { nickname: 'countess' });
```

`siren.collaborators.aliases` reads and gives out tracking and coupon codes. Siren files a
connected site's codes under its Property, as in `coupon@property:5`. `query`, `findByCode`,
`forCollaborator` and `create` answer each code with the plain type and the Property in
`propertyId`, through `PropertyQualifier`, so send and compare plain types. `list` reads the
collaborator record's own `aliases` field and answers each type as Siren stores it, as the PHP SDK
does. `create` raises `CodeConflictError` when another collaborator already holds
the code. Siren's 409 does not name the holder, so read `findByCode` before treating the code as
someone else's.

```ts
import { CodeConflictError, CollaboratorAliasType } from '@novatorius/siren';

try {
  await siren.collaborators.aliases.create('SAVE10', CollaboratorAliasType.Coupon, 42);
} catch (error) {
  if (!(error instanceof CodeConflictError)) throw error;
  const holder = await siren.collaborators.aliases.findByCode('SAVE10', CollaboratorAliasType.Coupon);
  if (holder?.collaboratorId !== 42) throw error;
}
```

`siren.collaborators.enrollments` enrolls collaborators in programs and reads who belongs where.

```ts
await siren.collaborators.enrollments.add(42, 7);
const enrolled = await siren.collaborators.enrollments.programsFor(42);
const members = await siren.collaborators.enrollments.collaboratorsIn(7, { status: 'active' });
```

`siren.collaboratorGroups` manages named sets of collaborators, and `siren.collaboratorGroups.members`
manages who is in each one.

```ts
const group = await siren.collaboratorGroups.create({ name: 'Podcasters', structure: 'flat' });
await siren.collaboratorGroups.members.add(group.id, [{ collaboratorId: 42 }]);
const inGroup = await siren.collaboratorGroups.members.list(group.id);
```

`siren.programs` and `siren.programGroups` manage programs and the groups whose programs compete
for one engagement.

```ts
import { ProgramGroupSorter } from '@novatorius/siren';

const activePrograms = await siren.programs.list({ status: 'active' });
const currencies = await siren.programs.currencyTypes();
await siren.programGroups.create({
  name: 'Launch partners',
  description: 'Programs that compete for launch sales',
  sorter: ProgramGroupSorter.NewestBindingWins,
});
```

Every record write is sent once: create, update, delete, bulk, the enrollment and member writes,
and the code writes. A write's answer is lost when it throws `ConnectionError` or a 5xx `ApiError`,
and each method's doc says how to find out what Siren did before you send it again. Reads retry on
a network error, 429 or 5xx, like the other reads. A caller that runs these calls from its own
durable queue builds the client with `maxRetries: 0`, so the queue owns every retry.

Each list sends only the filters its route reads. A list throws `SirenError` for a key its route
does not read, before sending, because Siren ignores an unknown key and would answer every record.
An empty filter list throws `SirenError` too, since leaving it out would also answer every record.
A filter value holding a comma throws as well, because Siren reads a comma as "any of". Only
`fields` and the search text `s` may hold one. Every id must be a positive whole number.

## Storefront module (browser)

Siren's storefront routes are public, because a shopper's browser calls them. The
`@novatorius/siren/storefront` subpath holds the code for that. It uses `fetch`, needs no API key,
and imports no Node built-ins, so a bundler can ship it to a browser.

```ts
import { SirenStorefront, storefrontUrls, isVisitToken } from '@novatorius/siren/storefront';

// The URLs come from the storefront block of an inbound connection in Siren Cloud,
// or from the source and its public storefront key.
const { visitUrl, claimUrl } = storefrontUrls({ source: 'shopify', key: storefrontKey });
const storefront = new SirenStorefront({ visitUrl, claimUrl });

// A page opened with ?ref=jane. Resolves to null when Siren refuses the request,
// so you can try again on the next page. A network failure rejects.
const visit = await storefront.recordVisit({ ref: 'jane', visitToken: storedToken });
if (visit?.recorded && isVisitToken(visit.visitToken)) {
  keepToken(visit.visitToken, visit.attributionWindowDays);
}

// A checkout that skips the cart claims its order with the stored token.
await storefront.claimOrder({ visitToken, orderId: '5551234', total: '49.99', currency: 'USD' });
```

The module also exports the shapes of both requests and answers (`StorefrontVisitRequest`,
`StorefrontVisitResponse`, `StorefrontClaimRequest`, `StorefrontClaimResponse`,
`StorefrontSettings`), and the values scripts share: `VISIT_STORAGE_KEY`, `VISIT_TOKEN_PATTERN`,
`SHOPIFY_TRACKING_ATTRIBUTE`, `STRIPE_TRACKING_ATTRIBUTE`, `DEFAULT_ATTRIBUTION_WINDOW_DAYS` and
`MAX_ATTRIBUTION_WINDOW_DAYS`. `stripeSafeToken` spells a token with an underscore for Stripe,
which drops a reference that holds a dot. Siren reads both spellings. `attributionWindowDays`
turns the window Siren returns into a safe number of days.

The module only talks to Siren. Keeping the token in a cookie or localStorage, and writing it to a
cart or a Stripe link, stay with your script.

### Application forms

A Siren Cloud application form can run on your own site. The same module reads the form, sends
applications, and confirms them, from the visitor's browser. Call these from the browser, not your
server: Siren limits applications per visitor address.

```ts
import { getApplicationForm, submitApplication, verifyApplication } from '@novatorius/siren/storefront';

// Null when the form is off or gone.
const form = await getApplicationForm({ orgSlug: 'acme', formSlug: 'partners' });
// Render form.builtInFields, then form.fields, then a hidden field named form.honeypot.

const result = await submitApplication({
  orgSlug: 'acme',
  formSlug: 'partners',
  honeypotField: form.honeypot,
  application: { nickname, fullName, email, answers: { website: 'https://example.com' } },
  // The visit's opportunity, such as visit.opportunityId from recordVisit, credits the
  // collaborator who referred the applicant.
  referral: { opportunityId: storedOpportunityId },
});
if (!result.ok) showErrors(result.fieldErrors); // a message per field, for the applicant

// On the confirmation page the form's confirmation email links to, with ?token=.
const confirmed = await verifyApplication({ token: new URLSearchParams(location.search).get('token')! });
```

`submitApplication` resolves to a refusal with `status` 400 for a built-in field, 422 for an
answer, 404 for a form that is off, and 429 over a rate limit, with `retryAfter` in seconds. A
network failure rejects.

## API key scopes

An API key does what its scopes allow. `ApiKeyScope` names each one:

| Scope | What the key can do |
|---|---|
| `ApiKeyScope.AllEvents` (`event:*`), `eventScope(slug)` | Send events |
| `ApiKeyScope.LedgerConversionsRead` (`ledger:conversions:read`) | `conversions.list()` |
| `ApiKeyScope.LedgerTransactionsRead` (`ledger:transactions:read`) | `transactions.list()` |
| `ApiKeyScope.LedgerObligationsRead` (`ledger:obligations:read`) | `obligations.list()` |
| `ApiKeyScope.LedgerPayoutsRead` (`ledger:payouts:read`) | `payouts.list()` |
| `ApiKeyScope.WebhookSubscriptionsRead` (`webhook-subscriptions:read`) | `webhooks.subscriptions.list()` |
| `ApiKeyScope.WebhookSubscriptionsManage` (`webhook-subscriptions:manage`) | Every `webhooks.subscriptions` call, and a test delivery (`POST /webhooks/{id}/test`, which the SDK has no method for) |

Siren grants the ledger and webhook scopes only by their exact names. `*`, `event:*`, wildcards
such as `ledger:*`, and older names such as `conversions:read` grant none of them, so a key made
before these scopes existed reads nothing until you replace it with one that holds them. A key's
requests count against the organization's API rate limit.

`apiKeys.create`, `list`, `revoke` and `scopes` take a signed-in dashboard session's token. No API
key scope reaches them, and Siren answers a key there with an `ApiKeyNotAcceptedError`.

`apiKeys.scopes()` lists every scope a new key may hold, grouped by resource: the event scopes under
`events`, with any custom event types your organization added, the ledger scopes under `ledger`,
the webhook scopes under `webhook-subscriptions`, and the record scopes under one `records:*` group
each. Each entry carries the `scope` string to pass to `apiKeys.create` and a readable `label`:

```ts
const groups = await siren.apiKeys.scopes();
for (const entry of groups.ledger ?? []) console.log(entry.scope, entry.label);
// ledger:conversions:read Read conversions
```

```ts
import { ApiKeyScope } from '@novatorius/siren';

const key = await siren.apiKeys.create({
  label: 'Accounting export',
  scopes: [ApiKeyScope.LedgerConversionsRead, ApiKeyScope.LedgerPayoutsRead],
});
// key.rawKey (sk_live_...) is returned ONCE and cannot be retrieved later.
```

A key created with a `propertyId` is bound to that store. It reads only its own store's
conversions, transactions and obligations, and Siren refuses it on payouts and webhook
subscriptions with a `StoreKeyNotAllowedError`. An organization-wide key reads the whole
organization, and narrows a ledger read to one store with `propertyId`:

```ts
const storeConversions = await siren.conversions.list({ propertyId: 5, status: 'approved' });
```

## Configuration

```ts
const siren = new Siren({
  apiKey: 'sk_live_...',                                 // or accessToken, never both
  baseUrl: 'https://api.sirenaffiliates.com/siren/v1',   // default, point at staging/local as needed
  timeout: 30_000,                                       // ms, default 30s
  maxRetries: 2,                                         // default 2
  httpClient: new FetchHttpClient(),                     // default, or your own HttpClient
});
```

Pass `apiKey` or `accessToken`, never both. Both, neither or an empty one throws `SirenError`
when you build the client. So does a token with a control character or a character above U+00FF,
which cannot go in an HTTP header. `baseUrl` takes an http or https URL with no user name or
password in it, made only of visible ASCII (U+0021 to U+007E) with no query, fragment, backslash
or `@`. It starts with `http://` or `https://` and the host, which holds no `%`. An international
host goes in its punycode form, such as `xn--bcher-kva.example`.
`timeout` takes a number of milliseconds from 1 to 2147483647 for each send, and a retry gets the
full timeout again. `maxRetries` takes a whole number of 0 or more, with no ceiling.
Any other value, NaN, Infinity and `null` included, throws `SirenError` that names the option. The
client reads only the options object's own properties, so a value inherited from a prototype is
ignored.

### Access tokens

A connected store sends an OAuth access token instead of an API key. `accessToken` takes the token
as a string, or an `AccessTokenSource` that supplies it and gets a fresh one when Siren refuses it:

```ts
import { CallbackAccessTokenSource, ConnectorScope, Siren } from '@novatorius/siren';

const siren = new Siren({
  accessToken: new CallbackAccessTokenSource(
    () => store.accessToken(),
    (rejected) => oauth.refresh(rejected), // answer null when the grant is gone
  ),
});

// The scopes a connected site asks for in its OAuth flow.
authorizeUrl.searchParams.set('scope', ConnectorScope.CONNECTED_SITE);
```

The SDK reads the token once per call, before the first send. When Siren answers a 401, the SDK
asks the `AccessTokenSource` to refresh once and resends the request once with the new token,
writes included, because Siren answers a 401 before it records anything. That resend does not
count against `maxRetries`. A second 401 raises `AuthenticationError`, or `SiteDisconnectedError`
when the organization revoked the site, which then needs to reconnect. An `apiKey` or a string
`accessToken` is never refreshed, so its 401 raises after one send. An error the source throws
reaches you unchanged, so a source whose refresh Siren refuses should answer `null` and let the
401 surface. Each call refreshes at most once, and a source shared by concurrent callers keeps its
own lock.

### Retries

Idempotent reads, sales and refunds automatically retry network errors and 429/5xx responses with
exponential backoff (honoring `Retry-After`). The management writes `apiKeys.create` and
`webhooks.subscriptions.create` are **never** auto-retried, so a flaky connection can't mint
duplicate credentials. `events.siteVisited` is never retried either, because Siren records every
visit it receives. `events.ingest` is sent once for every slug, and a sale with no `externalId` is
sent once, because Siren has no key to match a resent copy of either. A 403 or 409 is sent once.
A 401 is resent once after a refresh when the credential is an `AccessTokenSource` that can
refresh, and a send-once request never goes out again after that resend.

If your app sends events from a durable queue, set `maxRetries: 0`. The queue owns redelivery, and
an SDK retry inside a queued attempt would multiply the attempts. At 0 a request still goes out a
second time after a 401 when the `AccessTokenSource` refreshes, because Siren refused the first
send before it recorded anything. A retriable call makes at most `maxRetries + 2` sends: the first,
its retries and that one resend. Each send gets its own `timeout`, and the SDK waits at most 8 s
between retries, so a call can take up to `maxRetries + 2` timeouts plus that backoff. `maxRetries`
covers a brief network fault inside one call. Work that must survive an outage belongs on a durable
queue, not on a high `maxRetries`.

### Your own HTTP stack

By default the SDK sends through `FetchHttpClient`, over the global `fetch`. A host with its own
HTTP stack implements `HttpClient`, one `send(request)` method, and passes it as `httpClient`. The
request carries the full URL, every header, the body and `timeout` in milliseconds. Answer an
`HttpResponse` with the status, the headers and the body as text for every status, 3xx, 4xx and
5xx included. An `HttpClient` must never follow a redirect and answers the 3xx as it is, because a
followed redirect would send the bearer token to another host. The SDK raises a 3xx as
`SirenError`. An `HttpClient` keeps the request headers out of every error it throws, because they
carry the token and the SDK hands that error to you unchanged as `cause`. Reject with
`HttpClientError` only when no complete response arrived, such as a refused connection or a
timeout. The SDK may resend those and then raises `ConnectionError`. Any other error reaches you
unchanged and is never resent.

## Connected sites

A store that connects to Siren Cloud as a site, such as a Medusa store, takes its tools from the
`@novatorius/siren/connect` entry. It registers an OAuth client, sends the merchant to Cloud's
consent screen, exchanges the code the callback brings back, and then calls Cloud with the site's
own access token. The SDK keeps nothing, so the store keeps the client id, the state, the verifier
and the token pair in its own storage.

### Register and connect

```ts
import {
  ConnectorSoftware,
  OAuthClient,
  codeChallengeS256,
  createCodeVerifier,
  createState,
} from '@novatorius/siren/connect';

const oauth = new OAuthClient();
const redirectUri = 'https://store.example/siren/callback';

// Once per store. Keep client_id.
const registration = await oauth.register({
  clientName: 'Example Store',
  redirectUris: [redirectUri],
  softwareId: ConnectorSoftware.Medusa,
});

// Each time the merchant connects.
const verifier = createCodeVerifier();
const state = createState();
await store.saveConnectAttempt({ verifier, state });
const consentUrl = oauth.authorizeUrl({
  clientId: registration.client_id,
  redirectUri,
  state,
  codeChallenge: codeChallengeS256(verifier),
});
```

`new OAuthClient()` takes `baseUrl`, `consentScreenUrl`, `timeout` and `httpClient`, reads only
the options object's own properties, and checks each as `new Siren()` checks `baseUrl`, `timeout`
and `httpClient`. Its wait defaults to 15 seconds. `register` makes a new client every time it
runs, so a store registers once and keeps `client_id`. `authorizeUrl` sends nothing. It builds the consent screen URL from the S256
challenge and refuses anything else, so the verifier never reaches the merchant's browser.

When the merchant approves, Cloud sends the browser back to the redirect URI with `code` and
`state`. The store compares the callback's `state` with the one it kept, refuses a mismatch, and
uses each `state` once. Then it exchanges the code:

```ts
const tokens = await oauth.exchangeCode({
  clientId: registration.client_id,
  code: callback.code,
  redirectUri,
  codeVerifier: attempt.verifier,
});
await store.saveTokens(tokens); // access_token and refresh_token, as Cloud sent them
```

A code works once. After a `ConnectionError` from `exchangeCode`, the store cannot know whether
Cloud spent the code, so it starts the connection over with a new verifier and state.

### Refresh

```ts
const pair = await oauth.refresh({
  clientId: registration.client_id,
  refreshToken: saved.refresh_token,
  attemptId: createState(),
});
await store.saveTokens(pair);
```

Cloud rotates the refresh token on every refresh, so the store saves the new pair before anything
else reads it. A refresh is sent exactly once and never retried by the SDK, whatever the answer.
The store takes its own lock around each refresh, so two refreshes of one token never race. Give
each refresh a random `attemptId` on its first try, such as one from `createState()`, because a
resend cannot add one later.

Cloud keeps a 30-second reuse window from the rotation. Inside it, a repeat that carries the same
`attemptId` gets the pair Cloud already issued. Any repeat after 30 seconds makes Cloud revoke the
whole token family. So after a `ConnectionError`, a 429 or a 5xx, the store may resend that
refresh once, with the same `attemptId`, and it sends that resend at once, as Siren's WordPress
plugin does. A request that cannot wait hands the resend to a background task that runs straight
away, never to a queue that waits minutes. If the resend fails too, the store sends nothing more
for that refresh. A refresh refused with `invalid_grant` or `invalid_client` means the grant is
gone, and the site connects again.

### SirenConnect

```ts
import { CallbackAccessTokenSource, SirenConnect } from '@novatorius/siren/connect';

const siren = new SirenConnect({
  accessToken: new CallbackAccessTokenSource(
    () => store.accessToken(),
    (rejected) => store.refreshUnderLock(rejected), // answer null when the grant is gone
  ),
});

const plan = await siren.connect.plan();
await siren.connect.reportSiteState({ forwarding: true });
```

`SirenConnect` is the client a connected site holds once it has tokens. It takes the options
`new Siren()` takes, with `accessToken` required and no `apiKey`. When `accessToken` is an
`AccessTokenSource`, a 401 makes the client ask it for a fresh token once and resend once, as
`new Siren()` does. `siren.connect` holds the `/connect/*` routes and `/ping`, and each method
names the `ConnectScope` its route needs. `siren.events` forwards the site's events.

The reads, `updateGrant` and `webhook.delete` retry like any read. `webhook.delete` answers
`deleted: false` when the site had no webhook left to remove, which is also what a retry after a
lost answer meets, so it counts as success. The three reports, `reportSiteState`,
`reportIntegrations` and `syncProducts`, are sent once, because the site's task queue sends them
again. `disconnect` is sent once, because Cloud cuts the client off as it commits, so a 401 after
a `disconnect` means the site is disconnected. A site that calls a retried route from its own
queue builds its client with `maxRetries: 0`. `customerEmailKey` answers the key the site hashes
customer emails with.

### The site's webhook

```ts
const subscription = await siren.connect.webhook.replace({
  targetUrl: 'https://store.example/siren/webhook',
  events: ['conversion.approved', 'payout.paid'],
});
await store.saveSigningSecret(subscription.signingSecret);
```

`replace` creates or replaces the site's subscription and answers a new signing secret, which
Cloud shows only in that answer. It is sent once, because each send rotates the secret. After a
`ConnectionError` from `replace`, the site cannot know whether the secret rotated, so it calls
`replace` again before it trusts the stored secret. The site verifies every delivery with
`constructEvent` and the signing secret, as in
[Quickstart: verify a webhook](#quickstart-verify-a-webhook), and drops any delivery that fails.
Never log the customer email key or the signing secret, and keep both out of error reports.

### Forwarding events

```ts
import { ForwardedEventSlug } from '@novatorius/siren/connect';

await siren.events.forward(
  ForwardedEventSlug.ProductDeleted,
  {
    version: 1,
    eventId: row.eventId,
    origin: 'site',
    occurredAt: '2026-11-12T09:30:00+00:00',
    data: { integration: 'medusa', platformId: 'prod_01', changedAt: '2026-11-12T09:30:00+00:00' },
  },
  { finalAttempt: row.isLastTry },
);
```

`events.forward` sends one of the site's events in Siren's versioned envelope. Before sending, it
refuses a slug outside `ForwardedEventSlug`, so a typo never becomes a custom event. It also
refuses an envelope Cloud would refuse. `events.forward` is sent once, whatever `maxRetries` says,
because the site's outbox owns redelivery. After a 401 it sends again with a refreshed token, and
only then. Mint the `eventId` once, when the site records the event, and keep it with the event.
The outbox resends a failed event with that same `eventId` and the same token, and Cloud answers
an event it already recorded with `status: duplicate`, which the outbox counts as delivered. On
the outbox's last try, pass `finalAttempt: true`, which adds the `X-Siren-Final-Attempt: 1`
header.

## Other SDKs

Siren ships official SDKs in three languages, all built against the same API:

- **Node.js / TypeScript** — this repository
- **Python** — https://github.com/Novatorius/siren-python
- **PHP** — https://github.com/Novatorius/siren-php

## Links

- Siren — https://sirenaffiliates.com
- OpenAPI specification — [`./openapi.yaml`](./openapi.yaml)
- Issues — https://github.com/Novatorius/siren-node/issues

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to clone, build, test,
and open a pull request. Please also review our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Error handling

API and network failures throw a typed subclass of `SirenError`. Catch the base class to
handle any SDK error, or branch on a specific subclass. Every error has a `message`; `code`
(the API's machine-readable error code) and `statusCode` (the HTTP status) are set when the
failing response provides them, and `data` holds the error's `context` — `ConnectionError` and `SignatureVerificationError`, for
example, carry no `statusCode`:

| Error | When it's thrown |
|---|---|
| `AuthenticationError` | Missing, invalid, expired or revoked API key (401) |
| `ApiKeyNotAcceptedError` | The route takes a dashboard session and not an API key (401, `code` `api_key_not_accepted`). Extends `AuthenticationError` |
| `SiteDisconnectedError` | The organization revoked or deleted the connected site's connection (401, `code` `site_disconnected`). Reconnect the site. Extends `AuthenticationError` |
| `PermissionError` | The credential may not do this (403) |
| `MissingScopeError` | The key holds none of the route's scopes (403, `code` `missing_scope`). `scope` and `anyOf` name them. Extends `PermissionError` |
| `StoreKeyNotAllowedError` | A key bound to one store asked for payouts or webhook subscriptions (403, `code` `store_key_not_allowed`). Extends `PermissionError` |
| `PolicyError` | Siren's policy refused the request, so sending it again fails again (403, one of the `POLICY_ERROR_CODES`). `param` names the refused field when Siren says which. Extends `PermissionError` |
| `NotFoundError` | The requested resource does not exist (404) |
| `BadRequestError` | Malformed request or failed validation (400). `fieldErrors` lists each broken rule |
| `ValidationError` | Request payload failed validation on a route that answers 422 |
| `ConflictError` | Conflicting state, e.g. a duplicate (409) |
| `CodeConflictError` | Someone already holds the tracking or coupon code (409, `code` `code_held`). `conflictingCode` and `type` name it. Raised by a resource that assigns codes. Extends `ConflictError` |
| `HoldConflictError` | Siren refused a store credit hold (409). `reason` is `no_credit`, `token_in_use` or `null` (`HoldConflictReason`). Raised by a resource that places holds. Extends `ConflictError` |
| `RateLimitError` | Rate limit exceeded (429); honors `Retry-After` |
| `ApiError` | Unexpected server error (5xx) |
| `UnexpectedResponseError` | Siren answered with a success status, but the body has the wrong shape, such as an object where a list belongs. `data` holds the body. The deployment is broken, so do not retry. Extends `ApiError` |
| `ConnectionError` | Network failure reaching Siren |
| `SignatureVerificationError` | A webhook signature did not verify |

One exception to the subclass rule: constructing a client without an `apiKey` throws the base
`SirenError` itself.

`ErrorCode` holds every `error.code` Siren sends, and `isKnownErrorCode(code)` says whether a code
is one of them. The SDK picks a 401 or 403 class by the code when it knows it. A reply from an
older or newer Siren deployment may carry no code or one the SDK does not know, and then the SDK
reads Siren's wording instead. A reply it cannot place stays a plain `AuthenticationError` or
`PermissionError`, carrying everything Siren sent.

```ts
import {
  Siren,
  SirenError,
  RateLimitError,
  BadRequestError,
  NotFoundError,
} from '@novatorius/siren';

const siren = new Siren({ apiKey: process.env.SIREN_API_KEY! });

try {
  await siren.events.sale({
    source: 'stripe',
    externalId: 'cs_test_a1b2c3',
    total: 49.99,
    trackingId: 4021,
  });
} catch (err) {
  if (err instanceof RateLimitError) {
    // already retried with backoff; back off further or queue for later
  } else if (err instanceof BadRequestError) {
    // err.code is 'VALIDATION_FAILED' and err.fieldErrors names each field
    console.error('Invalid payload:', err.message, err.fieldErrors);
  } else if (err instanceof NotFoundError) {
    // nothing matched — e.g. a refund for a sale Siren never recorded
  } else if (err instanceof SirenError) {
    // statusCode/code are set when the API produced the failure
    console.error(`Siren error ${err.statusCode ?? 'n/a'} (${err.name}):`, err.message);
  } else {
    throw err; // not a Siren error
  }
}
```

## Resources

- [Siren homepage](https://sirenaffiliates.com)
- [npm package](https://www.npmjs.com/package/@novatorius/siren)
- [GitHub repository](https://github.com/Novatorius/siren-node)

## License

[MIT](./LICENSE) © 2026 Novatorius LLC
