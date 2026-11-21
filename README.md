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
- **Read the ledger** (`conversions`, `transactions`, `obligations`, `payouts`, `fulfillments`) and
  **manage webhook subscriptions** with an API key that holds the ledger and webhook scopes.
- **Build a Siren app** (`apps`, `apps.requestHandler`, `apps.verifyRequest`, `apps.requests.answer`) that acts as part of
  Siren's engine, and declare it with the `siren` command-line tool.

It runs on Node 18.3+ with zero runtime dependencies (it uses the global `fetch`), and ships ESM,
CJS, and full type declarations.

## Install

```sh
npm install @novatorius/siren
```

npm 11 may warn that the package has an install script not covered by `allowScripts`. It names
`prepare: tsup`, the build that a Git install of this package needs. npm does not run it for a
registry or tarball install, so you can ignore the warning.

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
await siren.events.ingest('loyalty-points-earned', { collaboratorId: 88, userId: 42, points: 100 });
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

A connected site that records a referral visit for a shopper who already holds a tracking value
sends that value with the visit, so Siren adds the visit to the shopper's opportunity.
`events.ingest` takes an optional third argument for this: `headers` for the call, and a `timeout`
in milliseconds that replaces the client's for this call alone. Send a signed token as
`X-Siren-Token` and a bare opportunity id as `X-Siren-Oid`:

```ts
await siren.events.ingest(
  'site-visited',
  { collaboratorId: 'tracking:summer-sale' },
  { headers: { 'X-Siren-Token': heldToken }, timeout: 2000 },
);
```

These headers go beneath the SDK's own, so they never replace `Authorization`, `Accept`,
`User-Agent` or `Content-Type`. A header name that is not an HTTP token, or a value with a control
character or a character above U+00FF, throws `SirenError` before anything is sent, and the message
never quotes the header.

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

### Check and change a subscription

These calls are deprecated for a Siren app, which holds its address now. Siren refuses them for an
address an app owns. See [The old key and webhook calls](#the-old-key-and-webhook-calls).

`retrieve(id)` reads one subscription, and `deliveries(id)` reads its latest 50 deliveries, newest
first, each with the payload Siren sent, its status (`pending`, `delivered` or `failed`), the tries
it took and the first 200 bytes of your endpoint's answer. Both take `webhook-subscriptions:read`
or `webhook-subscriptions:manage`.

`update(id, params)` changes the target URL, the events, the status or the description, and sends
only the fields you give. It throws `SirenError` before sending for any other key, and for an update
with no field that is not `null` or `undefined`, because Siren skips a `null` field and cannot apply
an update with nothing to change. `test(id)` makes Siren send one signed `webhook.test` delivery now and
answers what your endpoint did. Siren answers 200 either way, so read `delivered`. Both take
`webhook-subscriptions:manage`, and each is sent once.

```ts
const result = await siren.webhooks.subscriptions.test(sub.id);
if (!result.delivered) {
  const [latest] = await siren.webhooks.subscriptions.deliveries(sub.id);
  console.log(latest?.httpStatusCode, latest?.errorMessage, latest?.responseBody);
}

// Stop deliveries while you fix the endpoint, then start them again.
await siren.webhooks.subscriptions.update(sub.id, { status: 'paused' });
await siren.webhooks.subscriptions.update(sub.id, { status: 'active' });
```

Siren refuses a test for a paused subscription with a 409, raised as `ConflictError`. From one
address it allows 20 tests an hour for one subscription and 60 in all, and answers more with a 429,
raised as `RateLimitError`.

## Features

- **Event ingestion** — record sales, refunds, referred visits, and custom event types
  (`events.sale`, `events.refund`, `events.siteVisited`, `events.ingest`). Sales and refunds
  are auto-retried on network errors and 429/5xx. A visit, a custom event sent through
  `events.ingest` and a sale with no `externalId` are sent once.
- **Signed-webhook verification and subscriptions** — constant-time signature checks
  (`webhooks.constructEvent`, `webhooks.verifySignature`) plus subscription management
  (`webhooks.subscriptions.create` / `list` / `retrieve` / `update` / `delete` / `test` /
  `deliveries`) with an API key that holds a webhook scope.
- **API keys** — mint, list, and revoke keys (`apiKeys.create` / `list` / `revoke`), and list the
  scopes a new key may hold (`apiKeys.scopes()`), with a dashboard session's token. The raw key is
  returned once and cannot be retrieved later.
- **Reconciliation reads** — thin paginated readers over Siren's ledger for `conversions`,
  `transactions`, `obligations`, `payouts` and `fulfillments`, with an API key that holds the
  ledger scopes. `payouts.retrieve` and `fulfillments.retrieve` read one record.
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

Payouts sit inside fulfillments, the batches Siren pays out in. `payouts.retrieve(id)` reads one
payout, with `waitingReason` set when it waits on the collaborator's payout setup.
`fulfillments.list()` filters by `status`, by `payoutStatus` (only batches holding a payout in that
status) and by `currency`, `from` and `to`, and `fulfillments.retrieve(id, { include: 'extended' })`
adds the payout counts, the total and each payout. A payout's `value` is a whole number in the
currency's smallest unit. The key needs `ledger:payouts:read` or `ledger:fulfillments:read`, and
must be organization-wide. Both resources only read, since every payout write moves money.
`fulfillments.list()` throws `SirenError` before sending for a key the route does not read, a day
that is not real, and a `payoutStatus` or `currency` that is `""` or a list, since Siren would
answer every fulfillment or none.

```ts
const needAttention = await siren.fulfillments.list({ payoutStatus: 'failed' });
const batch = await siren.fulfillments.retrieve(needAttention[0]!.id, { include: 'extended' });
const payout = await siren.payouts.retrieve(batch.payouts![0]!.id);
```

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

## Store credit, mappings and commerce records

The client also carries the rest of the records a store connector reads and writes: opportunities,
engagements, distributors, custom currencies, store credit, mappings to records outside Siren, and
the settings Siren shares with a connected site. Conversions and transactions gain their writes.

```ts
import { ConversionBulkAction, DistributorBulkAction } from '@novatorius/siren';

// siren.opportunities and siren.engagements read the tracking side of the ledger.
const opportunities = await siren.opportunities.list({ collaboratorId: 42 });
const engagements = await siren.engagements.list({ collaboratorId: 42, from: '2026-10-01' });

// siren.distributors and siren.customCurrencies manage revenue pools and points.
await siren.distributors.bulk(DistributorBulkAction.Activate, [3, 4]);
const points = await siren.customCurrencies.retrieve('POINTS');

// siren.conversions.create and siren.transactions.create write the ledger.
const transaction = await siren.transactions.create({
  bindingId: 'invoice-1001',
  bindingDataType: 'invoice',
  details: [{ name: 'Consulting', value: 50000, quantity: 1, units: 'USD' }],
});
await siren.conversions.bulk(ConversionBulkAction.Approve, [101, 102]);
```

Send a binding with `transactions.create` whenever the outside record has an id. A resend after a
lost answer then gets a 409, raised as `ConflictError`, instead of making a second transaction.
Siren finds the first send only by `bindingId` and `bindingDataType` together, so the SDK refuses
one without the other, and a binding of `""`, `"0"` or `0`, which Siren reads as none. It refuses
a binding of `NaN`, `Infinity` or `-Infinity` too, since JSON writes each as `null`.

A conversion create and a collaborator credit take no binding. After either loses its answer, send
it again through `conversions.recoverCreate` or `transactions.recoverCreditCollaborator`, with the
same arguments. Each reads the conversions Siren holds and sends the write only for what is
missing. An answer it cannot read raises `UnexpectedResponseError` and sends nothing, so a broken
answer never makes a second conversion. An empty page whose `total` says Siren holds matching rows
raises the same way, since Siren counts the rows in a second query and a first send still in flight
can land between the two. The read and the send are two requests, so run one recovery
per record at a time.

```ts
const { conversion, created } = await siren.conversions.recoverCreate({
  engagementId: 31,
  transactionId: 71,
  type: 'sale',
  status: 'pending',
});
```

`siren.credits` reads a collaborator's store credit and places the checkout holds that reserve it.
`CreditsResource.holdReference` builds the reference a checkout's holds carry, for the `holds`
filter and for `checkoutBalances`, which leaves that checkout's own hold out of the balance.

```ts
import { CreditsResource, HoldConflictError } from '@novatorius/siren';

const reference = CreditsResource.holdReference('woocommerce', cartToken);
const [balance] = await siren.credits.checkoutBalances(42, 'STORE_CREDIT', reference);

try {
  await siren.credits.placeHold(42, 'STORE_CREDIT', 1500, cartToken, 'woocommerce');
} catch (error) {
  if (!(error instanceof HoldConflictError)) throw error;
  // error.reason is 'no_credit', 'token_in_use' or null
}
```

Calling `placeHold` again for the same checkout token and currency replaces that checkout's hold,
so a caller may repeat it after a lost answer. A hold ends when its `ttl` runs out, when the order
settles it, or when `releaseHold` frees it early. Call `releaseHold` only when the shopper drops
the credit, and never release the hold of a checkout that became an order, because the order's
settlement spends that hold and the same credit could be spent twice.

`siren.mappings` links collaborators to records outside Siren, such as WordPress users, and
`siren.settings` reads the settings Siren shares with a connected site.

```ts
await siren.mappings.create(42, '7', 'wordpress_user');
const [link] = await siren.mappings.forExternal('7', 'wordpress_user');
const settings = await siren.settings.collaborator();
```

Every write here is sent once, as in the section above, apart from the one resend after a 401.
Each write's doc says what a second send does and how to check before you send it again. Reads
retry on a network error, 429 or 5xx inside `maxRetries`, which is 2 unless you set it. A caller
that runs these calls from its own durable queue sets `maxRetries: 0` on the client, so the queue's
attempts are not multiplied. Each list throws `SirenError` for a key
its route does not read, and every id must be a positive whole number. The conversion, transaction,
custom currency and distributor creates send only the fields Siren reads and throw `SirenError`
for any other key, naming it.

## Parity with the PHP SDK

The first table compares this SDK with the Siren PHP SDK's next release, which adds seven calls and
the record scope list to PHP 0.3.0. The Node SDK carries every public method of that release under
the same name, with one left out. It also has thirty-one methods the PHP SDK does not have yet, listed
in the second table below.
The first table lists each PHP method, its Node name, and how the two differ where they do.
Across every record resource, Node throws `SirenError` before sending where PHP throws
`InvalidArgumentException`, a list answers a `SirenList` with `estimatedCount` where PHP answers
a `ListResult`, a 2xx answer of the wrong shape raises `UnexpectedResponseError`, every
record write is sent once, and a `retrieve` sends only `fields`, `include` and `propertyId`, where
PHP passes any key. The table covers the resource methods. PHP's `ListResource` also has three
public static helpers (`listQuery`, `query` and `toListResult`), which Node keeps internal.

| PHP | Node | Difference |
|---|---|---|
| `$siren->events->sale()` | `siren.events.sale()` |  |
| `$siren->events->refund()` | `siren.events.refund()` |  |
| `$siren->events->siteVisited()` | `siren.events.siteVisited()` |  |
| `$siren->events->ingest()` | `siren.events.ingest()` | Node takes an optional third argument, `{ headers, timeout }`, for the call's own request headers and wait. PHP's takes the slug and payload only. |
| `$siren->webhooks->constructEvent()` | `siren.webhooks.constructEvent()` |  |
| `$siren->webhooks->constructEventFromHeaders()` | none | Node leaves it out. `constructEvent` takes the request headers, a Fetch `Headers` or Node's `req.headers`, as its fourth argument and reads the event and delivery from them, which is what this PHP method adds. |
| `$siren->webhooks->verifySignature()` | `siren.webhooks.verifySignature()` |  |
| `$siren->webhooks->subscriptions->create()` | `siren.webhooks.subscriptions.create()` |  |
| `$siren->webhooks->subscriptions->events()` | `siren.webhooks.subscriptions.events()` |  |
| `$siren->webhooks->subscriptions->list()` | `siren.webhooks.subscriptions.list()` |  |
| `$siren->webhooks->subscriptions->delete()` | `siren.webhooks.subscriptions.delete()` |  |
| `$siren->webhooks->subscriptions->retrieve()` | `siren.webhooks.subscriptions.retrieve()` |  |
| `$siren->webhooks->subscriptions->update()` | `siren.webhooks.subscriptions.update()` |  |
| `$siren->webhooks->subscriptions->test()` | `siren.webhooks.subscriptions.test()` |  |
| `$siren->webhooks->subscriptions->deliveries()` | `siren.webhooks.subscriptions.deliveries()` | Throws `UnexpectedResponseError` for a body that is not a list or a row that is not an object. PHP keeps each member of what it decoded that is an array, as its `events()` does, so it drops a row that is not an array, reads each array member of a JSON object as a row, and answers `[]` for a body that is not JSON. |
| `$siren->apiKeys->create()` | `siren.apiKeys.create()` |  |
| `$siren->apiKeys->list()` | `siren.apiKeys.list()` |  |
| `$siren->apiKeys->scopes()` | `siren.apiKeys.scopes()` |  |
| `$siren->apiKeys->revoke()` | `siren.apiKeys.revoke()` |  |
| `$siren->conversions->list()` | `siren.conversions.list()` |  |
| `$siren->conversions->retrieve()` | `siren.conversions.retrieve()` |  |
| `$siren->conversions->create()` | `siren.conversions.create()` | Sends only the five fields Siren reads and refuses any other key, and refuses an `engagementId`, `transactionId` or `obligationId` that is not a positive whole number, where PHP sends the array as given. After a lost answer, `recoverCreate` sends it again only when Siren holds no such conversion. |
| `$siren->conversions->update()` | `siren.conversions.update()` | Answers `null` for the empty 200 Siren sends, or the record when Siren sends one, where PHP answers `[]`, which would look like a record. Refuses an `engagementId`, `transactionId` or `obligationId` that is not a positive whole number, as `create` does. |
| `$siren->conversions->delete()` | `siren.conversions.delete()` | Answers `null` for Siren's 204 and throws `UnexpectedResponseError` for an empty 200, where PHP answers `[]` for any empty body. |
| `$siren->conversions->bulk()` | `siren.conversions.bulk()` |  |
| `$siren->conversions->types()` | `siren.conversions.types()` |  |
| `$siren->transactions->list()` | `siren.transactions.list()` |  |
| `$siren->transactions->retrieve()` | `siren.transactions.retrieve()` |  |
| `$siren->transactions->details()` | `siren.transactions.details()` | Throws `UnexpectedResponseError` when the `details` field is missing or broken, where PHP answers `[]`, because Siren always sends a field it was asked for. |
| `$siren->transactions->create()` | `siren.transactions.create()` | Takes 1 to 500 detail lines, each an object, and throws `SirenError` before sending otherwise, where PHP checks only for a non-empty array. Sends only `details`, `bindingId` and `bindingDataType`, and only the seven line keys Siren reads, refusing any other key. Refuses half a binding, or a binding of `""`, `"0"` or `0`, which Siren reads as none. Refuses a binding field of `NaN`, `Infinity` or `-Infinity`, which JSON writes as `null`. |
| `$siren->transactions->bulk()` | `siren.transactions.bulk()` |  |
| `$siren->transactions->creditCollaborator()` | `siren.transactions.creditCollaborator()` | Takes 1 to 500 positive whole ids, a positive collaborator id and a non-empty `type`, and throws `SirenError` before sending otherwise. After a lost answer, `recoverCreditCollaborator` credits only the transactions that hold no conversion for the collaborator. A `type` of `null`, which Siren reads as `sale`, is refused, so leave `type` out for a sale. |
| `$siren->transactions->sources()` | `siren.transactions.sources()` |  |
| `$siren->obligations->list()` | `siren.obligations.list()` |  |
| `$siren->payouts->list()` | `siren.payouts.list()` |  |
| `$siren->payouts->retrieve()` | `siren.payouts.retrieve()` |  |
| `$siren->fulfillments->list()` | `siren.fulfillments.list()` | Refuses a key the route does not read, `propertyId` included, an empty filter list, and a comma in a filter, where PHP sends any other key as a filter. Both refuse a `payoutStatus` or `currency` of `""` or not a string, and a `from` or `to` that is not a real day. Node refuses a `null` filter, where PHP leaves it out. |
| `$siren->fulfillments->retrieve()` | `siren.fulfillments.retrieve()` |  |
| `$siren->collaborators->list()` | `siren.collaborators.list()` | Throws `SirenError` for a key the route does not read, an empty filter list, a comma outside `fields` and `s`, and an id filter that is not a positive whole number. |
| `$siren->collaborators->retrieve()` | `siren.collaborators.retrieve()` |  |
| `$siren->collaborators->create()` | `siren.collaborators.create()` |  |
| `$siren->collaborators->createPending()` | `siren.collaborators.createPending()` | Refuses `programs`, `distributors`, `groups` and `status` whatever their value, where PHP skips a `null` one. |
| `$siren->collaborators->updateDetails()` | `siren.collaborators.updateDetails()` | Sends only `fullName` and `nickname` and refuses every other key, `fields` and `id` included, where PHP passes `fields` and `id`. |
| `$siren->collaborators->update()` | `siren.collaborators.update()` |  |
| `$siren->collaborators->delete()` | `siren.collaborators.delete()` | Answers `null` for Siren's 204 and throws `UnexpectedResponseError` for an empty 200, where PHP answers `[]` for any empty body. |
| `$siren->collaborators->bulk()` | `siren.collaborators.bulk()` | Each action takes only its own extra, `programId` or `distributorId`, as a positive whole number, and the rest take none. Also runs `reject`, which Siren accepts. |
| `$siren->collaborators->statusTypes()` | `siren.collaborators.statusTypes()` |  |
| `$siren->collaborators->generateReferralCode()` | `siren.collaborators.generateReferralCode()` |  |
| `$siren->collaborators->aliases->list()` | `siren.collaborators.aliases.list()` |  |
| `$siren->collaborators->aliases->trackingCode()` | `siren.collaborators.aliases.trackingCode()` |  |
| `$siren->collaborators->aliases->setTrackingCode()` | `siren.collaborators.aliases.setTrackingCode()` | Trims the code and refuses one that is empty once trimmed or holds a comma, where PHP refuses only an empty string. |
| `$siren->collaborators->aliases->findByCode()` | `siren.collaborators.aliases.findByCode()` | Also sends `orderBy: dateIssued` and `order: DESC`, so the one row Siren answers is the newest. |
| `$siren->collaborators->aliases->forCollaborator()` | `siren.collaborators.aliases.forCollaborator()` | Also sends `orderBy: dateIssued` and `order: DESC`, so the one row Siren answers is the newest. |
| `$siren->collaborators->aliases->query()` | `siren.collaborators.aliases.query()` |  |
| `$siren->collaborators->aliases->create()` | `siren.collaborators.aliases.create()` | Also takes one integration's coupon type, such as `coupon@source:wc`, which Siren accepts on the alias routes. |
| `$siren->collaborators->aliases->free()` | `siren.collaborators.aliases.free()` |  |
| `$siren->collaborators->enrollments->programsFor()` | `siren.collaborators.enrollments.programsFor()` |  |
| `$siren->collaborators->enrollments->collaboratorsIn()` | `siren.collaborators.enrollments.collaboratorsIn()` |  |
| `$siren->collaborators->enrollments->enroll()` | `siren.collaborators.enrollments.enroll()` |  |
| `$siren->collaborators->enrollments->unenroll()` | `siren.collaborators.enrollments.unenroll()` |  |
| `$siren->collaborators->enrollments->replace()` | `siren.collaborators.enrollments.replace()` |  |
| `$siren->collaborators->enrollments->list()` | `siren.collaborators.enrollments.list()` |  |
| `$siren->collaborators->enrollments->add()` | `siren.collaborators.enrollments.add()` |  |
| `$siren->collaborators->enrollments->remove()` | `siren.collaborators.enrollments.remove()` |  |
| `$siren->collaboratorGroups->list()` | `siren.collaboratorGroups.list()` |  |
| `$siren->collaboratorGroups->retrieve()` | `siren.collaboratorGroups.retrieve()` |  |
| `$siren->collaboratorGroups->create()` | `siren.collaboratorGroups.create()` |  |
| `$siren->collaboratorGroups->update()` | `siren.collaboratorGroups.update()` |  |
| `$siren->collaboratorGroups->delete()` | `siren.collaboratorGroups.delete()` |  |
| `$siren->collaboratorGroups->structures()` | `siren.collaboratorGroups.structures()` |  |
| `$siren->collaboratorGroups->members->list()` | `siren.collaboratorGroups.members.list()` |  |
| `$siren->collaboratorGroups->members->add()` | `siren.collaboratorGroups.members.add()` |  |
| `$siren->collaboratorGroups->members->set()` | `siren.collaboratorGroups.members.set()` |  |
| `$siren->collaboratorGroups->members->remove()` | `siren.collaboratorGroups.members.remove()` |  |
| `$siren->programs->list()` | `siren.programs.list()` |  |
| `$siren->programs->retrieve()` | `siren.programs.retrieve()` |  |
| `$siren->programs->create()` | `siren.programs.create()` |  |
| `$siren->programs->update()` | `siren.programs.update()` |  |
| `$siren->programs->delete()` | `siren.programs.delete()` |  |
| `$siren->programs->bulk()` | `siren.programs.bulk()` |  |
| `$siren->programs->statusTypes()` | `siren.programs.statusTypes()` |  |
| `$siren->programs->incentiveTypes()` | `siren.programs.incentiveTypes()` |  |
| `$siren->programs->currencyTypes()` | `siren.programs.currencyTypes()` |  |
| `$siren->programGroups->list()` | `siren.programGroups.list()` |  |
| `$siren->programGroups->retrieve()` | `siren.programGroups.retrieve()` |  |
| `$siren->programGroups->create()` | `siren.programGroups.create()` |  |
| `$siren->programGroups->update()` | `siren.programGroups.update()` |  |
| `$siren->programGroups->delete()` | `siren.programGroups.delete()` |  |
| `$siren->programGroups->bulk()` | `siren.programGroups.bulk()` |  |
| `$siren->opportunities->list()` | `siren.opportunities.list()` | Refuses `id` and `s`, which Siren ignores for an organization and so would answer every opportunity. Read one by id with `retrieve`. |
| `$siren->opportunities->retrieve()` | `siren.opportunities.retrieve()` |  |
| `$siren->opportunities->update()` | `siren.opportunities.update()` |  |
| `$siren->engagements->list()` | `siren.engagements.list()` | Also takes `from` and `to`, each a day as `YYYY-MM-DD`, which Siren reads beside the four filters PHP names. Refuses either when it is not a real day, which Siren would leave out and answer every engagement. |
| `$siren->engagements->retrieve()` | `siren.engagements.retrieve()` |  |
| `$siren->engagements->types()` | `siren.engagements.types()` |  |
| `$siren->engagements->calculations()` | `siren.engagements.calculations()` |  |
| `$siren->distributors->list()` | `siren.distributors.list()` | Refuses a `metricType` of `""`, which Siren reads as no filter. |
| `$siren->distributors->retrieve()` | `siren.distributors.retrieve()` |  |
| `$siren->distributors->create()` | `siren.distributors.create()` | Sends only the fifteen fields PHP documents, which Siren reads, and refuses any other key, where PHP sends the array as given. |
| `$siren->distributors->update()` | `siren.distributors.update()` |  |
| `$siren->distributors->delete()` | `siren.distributors.delete()` | Answers `null` for Siren's 204 and throws `UnexpectedResponseError` for an empty 200, where PHP answers `[]` for any empty body. |
| `$siren->distributors->bulk()` | `siren.distributors.bulk()` |  |
| `$siren->distributors->creditMetric()` | `siren.distributors.creditMetric()` | Also takes `points`, a whole number from 1 to 1,000,000,000,000, which Siren reads for a distributor with no point value. |
| `$siren->customCurrencies->list()` | `siren.customCurrencies.list()` |  |
| `$siren->customCurrencies->retrieve()` | `siren.customCurrencies.retrieve()` | Takes only `fields`, and every code must be letters, digits, underscores and hyphens, since the code is a path segment on update and delete. |
| `$siren->customCurrencies->create()` | `siren.customCurrencies.create()` | Sends only the eight fields Siren reads, `scale` and `propertyIds` included, which PHP does not document, and refuses any other key. The code must be letters, digits, underscores and hyphens. |
| `$siren->customCurrencies->update()` | `siren.customCurrencies.update()` | The code must be letters, digits, underscores and hyphens, since it is a path segment. |
| `$siren->customCurrencies->delete()` | `siren.customCurrencies.delete()` | The code must be letters, digits, underscores and hyphens. Throws `UnexpectedResponseError` when a 2xx carries no object, where PHP answers `[]`. |
| `$siren->credits->adjust()` | `siren.credits.adjust()` | The currency must be letters, digits, underscores and hyphens, where PHP checks only that it is not empty. |
| `$siren->credits->balances()` | `siren.credits.balances()` | Throws `UnexpectedResponseError` when the `creditBalances` field is missing or broken, where PHP answers `[]`, so "no credit" never stands in for a broken answer. |
| `$siren->credits->checkoutBalances()` | `siren.credits.checkoutBalances()` | Throws `UnexpectedResponseError` for a body that is not a list, where PHP drops broken rows, and carries no `held` field, since Siren sends none. The currency must be letters, digits, underscores and hyphens. Refuses a missing `collaboratorId`, which Siren answers with a 400. |
| `$siren->credits->checkoutBalance()` | `siren.credits.checkoutBalance()` | The currency must be letters, digits, underscores and hyphens, where PHP checks only that it is not empty. |
| `$siren->credits->entries()` | `siren.credits.entries()` | A `collaboratorId` that is not a positive whole number does not count as naming the query, where PHP counts any number. The `currency` filter must be letters, digits, underscores and hyphens. |
| `$siren->credits->holds()` | `siren.credits.holds()` | A `collaboratorId` that is not a positive whole number does not count as naming the query, where PHP counts any number. The `currency` filter must be letters, digits, underscores and hyphens. `reference` takes only the form `holdReference` builds, so an API key filters a site's hold by `collaboratorId` and `status` instead. |
| `$siren->credits->placeHold()` | `siren.credits.placeHold()` | A 429 stays `RateLimitError`, where PHP raises `HoldLimitException`, because Siren has no hold cap. Every 409 becomes `HoldConflictError`. The currency must be letters, digits, underscores and hyphens. |
| `$siren->credits->releaseHold()` | `siren.credits.releaseHold()` | Sent once, where PHP retries. A release is safe to repeat, so the caller's queue repeats it. |
| `Credits::holdReference()` | `CreditsResource.holdReference()` |  |
| `$siren->mappings->list()` | `siren.mappings.list()` |  |
| `$siren->mappings->forExternal()` | `siren.mappings.forExternal()` | Refuses an external id with a comma, which Siren would read as "any of". `forLocal` reads such a link. |
| `$siren->mappings->forLocal()` | `siren.mappings.forLocal()` |  |
| `$siren->mappings->create()` | `siren.mappings.create()` |  |
| `$siren->mappings->deleteForCollaborator()` | `siren.mappings.deleteForCollaborator()` | Throws `UnexpectedResponseError` when a 2xx carries no object, where PHP answers `[]`. |
| `$siren->mappings->deleteForExternal()` | `siren.mappings.deleteForExternal()` | Throws `UnexpectedResponseError` when a 2xx carries no object, where PHP answers `[]`. |
| `$siren->settings->collaborator()` | `siren.settings.collaborator()` |  |
| `$siren->settings->value()` | `siren.settings.value()` | Also refuses a name holding a comma, with one message, since Siren reads a comma as "any of". |

`ApiKeyRecordScope` and `ApiKeyRecordScope::ALL` in PHP match Node's `ApiKeyRecordScope` and
`API_KEY_RECORD_SCOPES`, with the same thirty strings in the same order. PHP keeps Siren's constant
names, such as `ApiKeyRecordScope::FULFILLMENTS_READ`, where Node writes them in Pascal case, such
as `ApiKeyRecordScope.FulfillmentsRead`. PHP's `ApiKeyScope` names the eleven scopes Node's
`ApiKeyScope` does.

### Node methods the PHP SDK does not have yet

Each method below calls a route Siren serves today, or, for `siren.apps`, a route the Siren apps
work adds. `siren.apps.verifyRequest()`, `siren.apps.shownAmount()` and `siren.apps.splitPool()` read what Siren sends an app
and send nothing. Neither PHP 0.3.0 nor the PHP SDK's next release has a method for it. The PHP SDK is to
gain each one under the same name. The `siren` command-line tool ships with this package only.

| Node | Siren route | What it does |
|---|---|---|
| `siren.events.forward()` | `POST /event/{eventSlug}` | Sends a connected site's event in Siren's versioned envelope, once. |
| `siren.events.browserToken()` | `POST /oauth/token` | Gets a browser token for one of the app's custom events, kept until fewer than 60 seconds are left, with the event's send address. |
| `siren.events.browserTokenHandler()` | `POST /oauth/token` | Answers a page's request for a browser token, in Node's `(req, res)` or as a Web `Request` and `Response`. |
| `siren.conversions.recoverCreate()` | `GET /conversions`, then `POST /conversions` | After `create` lost its answer, sends it again only when Siren holds no such conversion. |
| `siren.transactions.recoverCreditCollaborator()` | `GET /conversions`, then `POST /transactions/credit-collaborator` | After `creditCollaborator` lost its answer, credits only the transactions that hold no conversion for the collaborator. |
| `siren.apps.declare()` | `PUT /apps/{key}` | Declares an app from its whole description, once. The first call answers its key, and its signing secret when the file names a `url`. |
| `siren.apps.create()` | `POST /apps` | Makes an app from the dashboard's door, with a key when `scopes` is sent and an address when `url` is, and answers each new secret once. |
| `siren.apps.update()` | `PATCH /apps/{key}` | Changes only the fields sent. `url: null` removes the address. |
| `siren.apps.list()` | `GET /apps` | Lists the organization's apps with their key, address and features. |
| `siren.apps.retrieve()` | `GET /apps/{key}` | Reads one app with its key, address and features. |
| `siren.apps.setStatus()` | `POST /apps/{key}/status` | Turns an app on or off. |
| `siren.apps.createKey()` | `POST /apps/{key}/key` | Makes a key for an app that has none, and answers it once. |
| `siren.apps.rotateKey()` | `POST /apps/{key}/key/rotate` | Gives an app a new key, shown once. The signing secret stays. |
| `siren.apps.revokeKey()` | `DELETE /apps/{key}/key` | Revokes an app's key. The app keeps its address. |
| `siren.apps.rotateSecret()` | `POST /apps/{key}/secret/rotate` | Gives an app's address a new signing secret, shown once. The key stays. |
| `siren.apps.test()` | `POST /apps/{key}/test` | Sends the app's address one signed `webhook.test` delivery and answers what it did. |
| `siren.apps.deliveries()` | `GET /apps/{key}/deliveries` | Lists the latest 50 deliveries to the app's address. |
| `siren.apps.events()` | `GET /apps/events` | Lists the events an app's address may receive. |
| `siren.apps.scopes()` | `GET /apps/scopes` | Lists the scopes an app's key may hold, grouped by resource. |
| `siren.apps.kinds()` | `GET /apps/kinds` | Lists the kinds of feature an app may add, with their settings and whether the plan can use each. |
| `siren.apps.delete()` | `DELETE /apps/{key}` | Deletes an app that no record selects and that has no open ask. |
| `siren.apps.verifyRequest()` | `POST /` at the app's own address, sent by Siren | Checks a request's timestamped signature and answers the parsed request. |
| `siren.apps.shownAmount()` | None. It reads the value and currency of a tell, which Siren sends as `POST /` to the app's own address | Reads a stored amount and its currency as a person reads them, such as `$15.00` for 1500 in dollars and `¥100` for 10000 in yen. |
| `siren.apps.requestHandler()` | `POST /` at the app's own address, sent by Siren, then `POST /apps/requests/{id}/answer` | Checks each request, hands it to the app's function for its kind and key, replies, and posts an ask's answer. |
| `siren.apps.splitPool()` | None. It splits the pool of a resolver's ask, which Siren sends as `POST /` to the app's own address | Splits a pool by weight in whole currency steps, never past the pool, evenly when every weight is 0. |
| `siren.apps.requests.list()` | `GET /apps/requests` | Lists the latest requests Siren sent the organization's apps. |
| `siren.apps.requests.retrieve()` | `GET /apps/requests/{requestKey}` | Reads one request, however old, with the data Siren sent, the answer it took and the person who answered by hand. |
| `siren.apps.requests.resend()` | `POST /apps/requests/{id}/resend` | Sends a request again under the same key. |
| `siren.apps.requests.answer()` | `POST /apps/requests/{id}/answer` | Posts an app's answer to an ask. A repeat of the same answer is safe. |
| `siren.apps.items.create()` | `POST /apps/{app}/items` | Adds one feature to an app that holds a key and an address. |
| `siren.apps.items.retrieve()` | `GET /apps/{app}/items/{id}` | Reads one feature with how many records select it and which. |
| `siren.apps.items.update()` | `PATCH /apps/{app}/items/{id}` | Changes a feature's name, description or settings. Its kind and key never change. |
| `siren.apps.items.delete()` | `DELETE /apps/{app}/items/{id}` | Archives a feature a record selects, and deletes one nothing selects. |

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

`track(eventKey, data)` sends one of an app's custom events from the page, with a browser token
from the app's own server. "Send a custom event" under Siren apps shows both halves.

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
| `ApiKeyScope.LedgerPayoutsRead` (`ledger:payouts:read`) | `payouts.list()`, `payouts.retrieve()` |
| `ApiKeyScope.WebhookSubscriptionsRead` (`webhook-subscriptions:read`) | `webhooks.subscriptions.list()`, `events()`, `retrieve()`, `deliveries()` |
| `ApiKeyScope.WebhookSubscriptionsManage` (`webhook-subscriptions:manage`) | Every `webhooks.subscriptions` call, `update()` and `test()` included |

`ApiKeyRecordScope` names all thirty record scopes Siren issues, in the order the dashboard offers
them, and `API_KEY_RECORD_SCOPES` lists them. Each name is the constant's name in Siren's
`ApiKeyRecordScopes` in Pascal case, so `FULFILLMENTS_READ` is `ApiKeyRecordScope.FulfillmentsRead`.
The six above carry the same strings under both names.

| Group | `ApiKeyRecordScope` names |
|---|---|
| The ledger, read only | `EngagementsRead`, `OpportunitiesRead`, `ConversionsRead`, `TransactionsRead`, `ObligationsRead`, `FulfillmentsRead`, `PayoutsRead` |
| Webhook subscriptions | `WebhooksRead`, `WebhooksManage` |
| Records a merchant sets up | `ProductsRead`, `ProductsManage`, `CouponsRead`, `CouponsManage`, `CollaboratorsRead`, `CollaboratorsManage`, `CollaboratorGroupsRead`, `CollaboratorGroupsManage`, `ProgramsRead`, `ProgramsManage`, `ProgramGroupsRead`, `ProgramGroupsManage`, `DistributorsRead`, `DistributorsManage`, `ApplicationFormsRead`, `ApplicationFormsManage`, `ApplicationsRead`, `ApplicationsManage`, `NotificationRulesRead`, `NotificationRulesManage`, `PropertiesRead` |

`ApiKeyRecordScope.FulfillmentsRead` (`ledger:fulfillments:read`) opens `fulfillments.list()` and
`fulfillments.retrieve()`. A manage scope reads everything its read scope reads.

```ts
import { ApiKeyRecordScope } from '@novatorius/siren';

const key = await siren.apiKeys.create({
  label: 'Payout app',
  scopes: [ApiKeyRecordScope.PayoutsRead, ApiKeyRecordScope.FulfillmentsRead, ApiKeyRecordScope.WebhooksManage],
});
```

Siren grants the ledger, webhook and record scopes only by their exact names. `*`, `event:*`,
wildcards such as `ledger:*`, and older names such as `conversions:read` grant none of them, so a
key made before these scopes existed reads nothing until you replace it with one that holds them.
A key's requests count against the organization's API rate limit.

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
conversions, transactions and obligations, and Siren refuses it on payouts, fulfillments and
webhook subscriptions with a `StoreKeyNotAllowedError`. An organization-wide key reads the whole
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

## Siren apps

A Siren app is a service you host that acts as part of Siren's engine. An app holds three parts:
its API key, its address (where Siren sends requests and events, signed with its signing secret)
and its features. Each feature joins one of Siren's pickers, so an organization chooses it as it
chooses a built-in one:

| Feature kind | Picked on | Siren sends |
|---|---|---|
| Action after a conversion (`postConversionAction`) | a program | A tell after each approved conversion. |
| Action after an allocation (`postAllocationAction`) | a distributor | A tell after each completed allocation. |
| Payout method (`payoutMethod`) | an autofulfiller | An ask to pay each payout, answered `{ outcome: 'paid', reference }`. |
| Distribution resolver (`distributionResolver`) | a distributor | An ask to divide each pool. |
| Custom event (`customEvent`) | a program or a distributor | Nothing. The app sends Siren the event. |
| Metric calculation (`metricCalculation`) | a distributor's metric type | An ask to score each metric, answered `{ outcome: 'scores', results }`. |
| Customer filter for distributors (`metricFilter`) | a distributor | An ask whether each collaborator's metric counts, answered `allow` or `suppress`. |
| Incentive resolver (`incentiveResolver`) | a program | An ask to split each sale's reward, answered `{ outcome: 'rewards', units, rewards }`. |
| Engagement calculation (`engagementCalculation`) | a program's engagement type | An ask who earns each engagement, answered `{ outcome: 'engagements', results }`. |
| Customer filter for programs (`engagementFilter`) | a program | An ask whether each engagement may be made, answered `allow` or `suppress`. |
| Collaborator group structure (`collaboratorGroupStructure`) | a collaborator group | An ask for the group's shape on each cascade trigger, answered a chain or a tree. |

Each kind's readable name is the `name` Siren's kinds catalog gives it, which `apps.kinds()` reads.
The tool prints it beside the kind, as Payout method (payoutMethod).

The code calls a feature an item, so the routes are `/apps/{app}/items` and the types are
`AppItem` and `AppItemKind`. `AppItemKind.FulfillmentMethod` is an old name for `payoutMethod`,
and Siren refuses the string `fulfillmentMethod`.

Apps are a Siren Cloud feature. The app routes take a signed-in admin's session token as
`accessToken`, and refuse an API key with `ApiKeyNotAcceptedError`. The `siren` command below signs
in for you and is the usual way to declare an app. Only the answer route takes the app's own key.

### Declare an app

`apps.declare(key, app)` sends the app's whole description with `PUT /apps/{key}`. The first call
makes the app and its API key, and its address when you give a `url`. It answers `created: true`
with `rawKey`, and `signingSecret` when it made an address. Siren shows each secret this once, so
keep them. Each later call updates the app in place and answers `created: false`. A later call
never makes or revokes a key. It makes an address when the `url` is new, and answers its
`signingSecret` once, and it removes the address and its delivery log when the `url` is gone.

An app with no `url` is a key-only app, for a script that reads Siren or sends custom events. An
app with any other feature needs a `url`, since Siren asks the app at its address, so `declare`
refuses those features with no `url` before sending. A feature's kind and key lock once Siren makes it.

```ts
const siren = new Siren({ accessToken: adminSessionToken });

const app = await siren.apps.declare('acme-payouts', {
  name: 'Acme',
  url: 'https://acme.example/siren',
  scopes: ['event:sale'],
  items: [
    { kind: 'postConversionAction', key: 'notify-crm', name: 'Tell the CRM' },
    { kind: 'payoutMethod', key: 'acme-ledger', name: 'Acme ledger', currencies: ['USD'] },
  ],
});
if (app.created) saveSecrets(app.rawKey, app.signingSecret);
```

`apps.list()` and `apps.retrieve(key)` read the apps with their key (`apiKey`, never more than its
prefix and last four characters), their address (`address`, never its secret) and their features.
`apps.setStatus(key, 'inactive')` turns an app off, which takes its features out of every picker
and stops Siren sending it anything. `apps.delete(key)` deletes an app that no record selects and
that has no open ask. Siren refuses one still in use with 409 `app_in_use`, and its `uses` and
`openRequests` say why.

An app key is lowercase letters and digits joined by single dashes, at most 64 characters, and
never `requests`, `events`, `scopes` or `kinds`. Each call refuses any other key, and any field its
route does not take, with `SirenError` before sending. The reads retry on a lost connection, 429
and 5xx. Every write is sent once.

### Change an app's parts

The dashboard changes an app one part at a time, and so can you:

- `apps.create({ name, url, scopes, events })` makes an app from the dashboard's door, with a key
  when `scopes` is a list, even `[]`, and an address when `url` is given. Siren picks its key.
- `apps.update(key, { name, description, url, events, scopes })` changes only the fields you send.
  `url: null` removes the address.
- `apps.createKey(key, { scopes })`, `apps.rotateKey(key)` and `apps.revokeKey(key)` make, rotate
  and revoke the key. A rotated key keeps its scopes, and the signing secret stays.
- `apps.rotateSecret(key)` gives the address a new signing secret. The key stays.
- `apps.test(key)` sends the address one signed `webhook.test` and answers what it did, and
  `apps.deliveries(key)` reads the address's latest 50 deliveries.
- `apps.items.create(key, feature)`, `apps.items.retrieve(key, id)`, `apps.items.update(key, id,
  change)` and `apps.items.delete(key, id)` add, read, change and remove one feature. `retrieve`
  answers how many records select it in `uses`, and which in `usedBy`. `create` may leave out `key`,
  and Siren then makes it from the name, adding `-2` when the app already holds it. `update` refuses
  a change to its `kind` or `key`.
- `apps.events()`, `apps.scopes()` and `apps.kinds()` read the events an address may receive, the
  scopes a key may hold, and the kinds of feature with their settings.

Each call that makes a secret answers it once, as `rawKey` or `signingSecret`. A feature, a kind
and the app's `eventsAccess` carry `entitled`, `requiredCapability` and `requiredPlan`. Everything
that goes out of Siren needs Pro, so on Plus an outward feature and the events read
`{ entitled: false, requiredPlan: 'pro' }`.

### The old key and webhook calls

`siren.apiKeys` and `siren.webhooks.subscriptions` are deprecated, because an app holds its key and
its address now. Each call's doc comment names the app call that replaces it: `apps.createKey()`
for a key, `apps.update()` for an address's url and events, `apps.deliveries()` for its deliveries,
and `apps.test()` for a test. Siren already refuses the webhook routes for an address an app owns.
These calls go when Siren removes their routes. `siren.webhooks.constructEvent()` and
`verifySignature()` stay, since an app's address receives events signed the same way.

### Answer Siren in a few lines

`apps.requestHandler()` answers Siren for you. Register a function for each feature by its kind and
key, and mount the handler at the app's address. It checks each request's signature, hands the
request to the function, and sends the reply Siren expects. For an ask, it replies 200 at once and
posts the answer the function returns.

```js
import express from 'express'
import { Siren } from '@novatorius/siren'

const siren = new Siren({ apiKey: process.env.SIREN_API_KEY, baseUrl: 'https://cloud.example.com/siren/v1' })
const answers = siren.apps.requestHandler({ signingSecret: process.env.SIREN_SIGNING_SECRET })

answers.on('postConversionAction', 'tell-the-crm', async ({ id, data }) => {
  // Siren may send it twice, so add it once, keyed by id.
  await addToCrm(id, data.conversion, data.reward)
})

express().post('/siren', express.raw({ type: 'application/json' }), answers).listen(3000)
```

Only the function changes for the other kinds. An Action after an allocation (`postAllocationAction`)
is a tell too:

```js
answers.on('postAllocationAction', 'note-the-share', async ({ id, data }) => {
  // Siren may send it twice, so note it once, keyed by id.
  await noteShare(id, data.allocation)
})
```

A Distribution resolver (`distributionResolver`) and an Incentive resolver (`incentiveResolver`) are
asks. The function returns the answer, and `apps.splitPool()` works out each share:

```js
answers.on('distributionResolver', 'split-by-score', ({ data }) => ({
  outcome: 'allocated',
  units: data.pool.units,
  // Whole currency steps, never more than the pool, split evenly when every score is 0.
  shares: siren.apps.splitPool(data.pool, data.metrics.map((metric) => [metric.metricId, metric.score])),
}))
```

```js
answers.on('incentiveResolver', 'split-the-reward', ({ data }) => ({
  outcome: 'rewards',
  units: data.pool.units,
  rewards: siren.apps.splitPool(data.pool, data.conversions.map((conversion) => [conversion.conversionId, conversion.score])),
}))
```

On Siren's sample question, a pool of 10000 with scores 30 and 20, `splitPool` gives
`{ '41': 6000, '43': 4000 }`. Each share is a whole number of the currency's smallest shown unit,
`10 ** (scale - decimalPlaces)` stored units, so a yen pool splits in multiples of 100. Every share
is rounded down, so the shares never add up to more than the pool. When every weight is 0, each id
gets the same. A negative or non-finite weight throws `SirenError`. `weights` is an object of id to
weight or a list of `[id, weight]` pairs.

`on(kind, fn)` takes every feature of a kind that no `on(kind, key, fn)` names, and
`onEvent(type, fn)` takes a webhook event sent to the same address, such as `conversion.approved`.
Each function's request is typed by its kind: `on('distributionResolver', ...)` gets
`AppAsk<AppDistributionQuestion>` and returns `AppDistributionAnswer`. The metric kinds are typed the same
way: `on('metricCalculation', ...)` gets `AppAsk<AppMetricCalculationQuestion>` and returns
`AppMetricCalculationAnswer`, and `on('metricFilter', ...)` returns `AppMetricFilterAnswer`. `on('engagementCalculation', ...)`
returns `AppEngagementCalculationAnswer` and `on('engagementFilter', ...)` returns `AppEngagementFilterAnswer`.
`on('collaboratorGroupStructure', ...)` gets `AppAsk<AppCollaboratorGroupStructureQuestion>` and returns
`AppCollaboratorGroupStructureAnswer`, a chain or a tree. The client must be built with
the app's own key, since the handler posts answers with it.

What the handler replies, always JSON with `Cache-Control: no-store`:

| Request | Reply | What happens next |
|---|---|---|
| A method other than POST | 405 | Nothing. |
| A body a parser already turned into an object | 500 | `onError` gets a `SirenError` that says to mount the handler before the JSON parser, or to give the route a raw body. |
| A missing or wrong `X-Siren-Signature-V2`, another `X-Siren-Timestamp`, or a time more than `toleranceSeconds` (default 300) from the clock | 401 | The checks are `verifyRequest`'s own. |
| A signed body that is not JSON, or an app request that is not an envelope of version 1 | 400 | Nothing. |
| A tell with a function | 200 once the function returns, 500 when it throws | Siren sends a failed tell again about 1, 2, 4 and 8 minutes later. The function has Siren's 8 seconds. |
| An ask with a function | 200 at once | The function runs after the reply, and the handler posts what it returns. When it returns `undefined`, answer later with `apps.requests.answer()`. |
| An app request with no function for its kind and key | 404 `No function handles <kind> <key>.` | Siren sends it again, then shows it under Needs attention. |
| Another event with an `onEvent` function | 200 once it returns, 500 when it throws | Nothing more. |
| Another event with no function | 200 | Nothing. |

The answer goes to `POST /apps/requests/{id}/answer`, checked first as `apps.requests.answer()`
checks it. A lost connection, 429 or 5xx sends the same answer again within the client's
`maxRetries`, which is safe because Siren takes the same answer again as `duplicate: true`. Siren's
refusals go to `onError` as the SDK's typed errors and are not sent again: 422
`app_answer_invalid`, 409 `app_request_already_answered` and `app_request_dropped`, 403 and 404.
When the function throws or no answer lands, Siren asks again after `answerBy`. The handler keeps
no state, and Siren may deliver one request twice, so a tell's function writes once by `id`.

Mount it on any server. None is a dependency of this package.

```ts
http.createServer(answers)                                              // node:http
app.post('/siren', express.raw({ type: 'application/json' }), answers)  // Express, Connect
fastify.register(answers.fastify, { path: '/siren' })                   // Fastify, with its own raw body parser
export const POST = answers                                             // Next.js app route
export default { fetch: answers }                                       // Workers, Bun, Deno, Hono
const reply = await answers.handle({ method, headers, rawBody })        // anything else: { status, headers, body, after }
```

With Node's `(req, res)` it reads a Buffer or string a raw parser left in `req.body`, or reads the
stream itself, up to 1 MiB. With a Web `Request` it answers a `Response`. An ask's work runs in the
process after the reply on a Node server, goes to `ctx.waitUntil` when a Worker passes it as the
third argument, and otherwise runs as a promise nothing awaits. A function host such as Vercel may
stop that promise, so pass `runLater: after` from `next/server` there, or any function that takes
the work, such as a queue's. From `handle()`, send the reply and then run `after()`. By default
`onError` writes one `console.error` line with the kind, key and request id, or an event's type and
delivery id, and the error. It never writes the request's data or headers. In TypeScript, the Web
`Request` signature is the handler's last, so Next.js 13 to 15 accept `export const POST = answers`.

### Check and answer by hand

The handler above runs the same checks and the same answer post as `apps.verifyRequest()` and
`apps.requests.answer()` below. Call them yourself when the app queues the work or answers after a
person decides. An ask's function that returns `undefined` leaves its answer to this path.

### Check a request

Siren sends each request as a `POST` to the app's `url`, signed with the app's signing secret in
`X-Siren-Signature-V2: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`.
`apps.verifyRequest(rawBody, headers, secret)` checks it against the exact bytes received and
answers the parsed request. It refuses a signature that does not match, a time more than 300
seconds from the receiver's clock either way, an `X-Siren-Event` other than `app.request`, and a
body that is not a request of version 1, each with `SignatureVerificationError`. It never falls back
to the older `X-Siren-Signature`, which signs no time.

```ts
// createAcmeApp is the example app's handler, examples/apps/acme/handler.mjs. Copy it, or write your own in its shape.
import { createAcmeApp } from './handler.mjs';

const appSiren = new Siren({ apiKey: process.env.SIREN_API_KEY! }); // the app's own key
const acme = createAcmeApp({ siren: appSiren, signingSecret: process.env.SIREN_SIGNING_SECRET!, log: console.log });

app.post('/siren', express.raw({ type: 'application/json' }), (req, res, next) => {
  acme.handle(req.body, req.headers).then((reply) => res.status(reply.status).type('application/json').send(reply.body), next);
});
```

Answer 200 as soon as the request checks out. Siren may deliver one request more than once. Drop a
repeat by the request's `id`. The `Idempotency-Key` header is not signed, so never use it to drop a
repeat.

The example's handler, which test/apps-example.test.ts drives with Siren's signed fixture, does the
parts that are easy to get wrong. It answers an ask after the 200, outside the request, and catches
an answer that fails, so a 5xx or a dropped connection is logged and never ends the process. It counts
an ask as handled only once Siren accepts the answer, so the next delivery answers again. A repeat that
arrives while the first answer is in flight waits for that answer, so two deliveries close together
answer once. An ask it cannot answer, such as a pool with no metrics, gets 500 and a logged line
that says why, never a guessed answer, so Siren sends it again on its deadline and then shows it as
needing attention. The route passes anything else that throws to `next`, so Express answers 500 and the process keeps running.

### Read what a tell says

A tell's `data` belongs to the feature's kind. An Action after a conversion (`postConversionAction`) gets
`AppConversionApprovedData`: the `conversion`, its `reward` as `{ value, units, currency }` or
`null` when it has none, and the `program`. An Action after an allocation (`postAllocationAction`) gets
`AppAllocationCompletedData`: the `allocation`, with `value`, `units` and `currency`, and the
`distributor`.

`value` is not the amount a person reads. It is the integer Siren stores, and the shown amount is
`value / 10^currency.scale`. Siren stores yen in hundredths, so a `value` of 10000 in yen is 100
yen, and a points currency an organization defines usually has scale 0, so 10000 is 10,000 points.
`units` is the currency code. Read an amount with `apps.shownAmount(value, currency)`, which answers
`{ amount, decimal, text }` the way Siren's dashboard reads it: `{ amount: 15, decimal: '15.00',
text: '$15.00' }` for 1500 in dollars, `{ amount: 100, decimal: '100', text: '¥100' }` for 10000 in
yen.

```ts
import type { AppConversionApprovedData } from '@novatorius/siren';

const request = siren.apps.verifyRequest(rawBody, headers, signingSecret);
if (request.mode === 'tell' && request.item.kind === 'postConversionAction') {
  const { conversion, reward } = request.data as unknown as AppConversionApprovedData;
  if (reward !== null) {
    const shown = siren.apps.shownAmount(reward.value, reward.currency);
    crm.note(conversion.collaboratorId, `Earned ${shown.text}`); // "Earned ¥100", never "Earned 10000"
  }
}
```

### Answer an ask

`apps.requests.answer(id, answer)` posts the answer with `POST /apps/requests/{id}/answer`, from a
`Siren` built with the app's own key, as `appSiren` is above. An admin's session may answer by hand,
but only a request that needs attention, which `siren apps requests --attention` lists. Siren refuses
a person's answer to any other ask with 409 `app_request_not_needing_attention`, since the app may
still answer it. The app's own key answers its own ask at any time before it is applied. The
answer is a plain object with a text `outcome`, at most 16384 bytes as JSON. The call answers
`{ status: 'accepted', duplicate }`.

The answer is sent once. When it is lost to a dropped connection or a 5xx, send the same answer
again. Siren takes each answer once, so `duplicate: true` means the first had already landed and
nothing more was applied. A different answer after an accepted one gets 409
`app_request_already_answered`, and the first one stands.

An ask carries `answerBy`. Siren sends an unanswered ask again when its window closes, three sends
in all, then marks it `needs_attention`. A feature's `answerWindowMinutes` sets the window, from 1
to 43200 minutes. A payout method waits a day and a distribution resolver an hour when the feature
sets none.

### Answer a reward ask

An Incentive resolver (`incentiveResolver`) gets `AppRewardQuestion` when a sale, renewal or lead
converts in a program that picks it: the `program`, the `conversionType`, the `transaction` (null
for a lead), the reward `pool` as a stored whole number, and the `conversions`, one per collaborator
with their engagement `score`. `reason` is `sale` while the rewards are not made yet, and `refund`
when a partial refund asks again about rewards already made. It answers `AppRewardAnswer`: the
pool's `units`, and in `rewards` every `conversionId` of the question as text, each a whole number of
0 or more or null for a collaborator who earns nothing. The rewards may add up to more than the
pool. Siren refuses any other key, a missing one, or a negative or fractional reward with 422
`app_answer_invalid`.

The rewards wait for the answer, and an incentive resolver waits an hour per send when the feature
sets no window. Siren waits 24 hours from the first ask about a sale at most. Then it stops waiting:
a sale's collaborators get no reward, and a refund cuts the rewards already made by the share
refunded. An answer after that gets 409 `app_request_dropped` (`AppErrorCode.Dropped`) as
`ConflictError`. While asks wait too long, the app's problem contacts, or the admins when it names
none, get an email about twice a week.

```ts
import type { AppRewardAnswer, AppRewardQuestion } from '@novatorius/siren';

const request = siren.apps.verifyRequest(rawBody, headers, signingSecret);
if (request.mode === 'ask' && request.item.kind === 'incentiveResolver') {
  const { pool, conversions } = request.data as unknown as AppRewardQuestion;
  const total = conversions.reduce((sum, conversion) => sum + conversion.score, 0);
  const rewards: AppRewardAnswer['rewards'] = {};
  for (const conversion of conversions) {
    rewards[String(conversion.conversionId)] = total > 0 ? Math.floor((pool.value * conversion.score) / total) : null;
  }
  const answer: AppRewardAnswer = { outcome: 'rewards', units: pool.units, rewards };
  await appSiren.apps.requests.answer(request.id, answer);
}
```

### Answer a metric ask

A Metric calculation (`metricCalculation`) gets `AppMetricCalculationQuestion`: the `distributor`,
the `distribution` period with its `periodEnd`, the `metricType`, the `triggeringCollaborator`, the
`opportunityId` and `points` (either may be null), the `cause` and the `sale`, which is null when no
sale caused the metric. It answers `AppMetricCalculationAnswer`, a score for each collaborator. Siren
takes at most 50 results, each collaborator once and each in the organization and not in the trash,
and each score a whole number of 0 or more. An empty list scores nobody. Set `scoresMoney: true` on
the feature when the score is an amount of money in the distributor's currency. Only a metric
calculation takes `scoresMoney`, and the app file refuses it on any other kind.

A Customer filter for distributors (`metricFilter`) gets `AppMetricFilterQuestion`, which names the
`collaborator` whose metric Siren is about to count. It answers `AppMetricFilterAnswer`: allow the
metric, or suppress it with a plain text reason of 1 to 200 characters.

```ts
import type { AppMetricCalculationAnswer, AppMetricFilterAnswer, AppMetricFilterQuestion } from '@novatorius/siren';

const request = siren.apps.verifyRequest(rawBody, headers, signingSecret);
if (request.mode === 'ask' && request.item.kind === 'metricCalculation') {
  const answer: AppMetricCalculationAnswer = { outcome: 'scores', results: [{ collaboratorId: 7, score: 10 }] };
  await appSiren.apps.requests.answer(request.id, answer);
}
if (request.mode === 'ask' && request.item.kind === 'metricFilter') {
  const { collaborator } = request.data as unknown as AppMetricFilterQuestion;
  const answer: AppMetricFilterAnswer = crm.ownsCustomer(collaborator.id)
    ? { outcome: 'suppress', reason: 'Customer already owned by a partner' }
    : { outcome: 'allow' };
  await appSiren.apps.requests.answer(request.id, answer);
}
```

### Answer an engagement ask

An Engagement calculation (`engagementCalculation`) gets `AppEngagementCalculationQuestion` each time
an engagement triggers for a program whose engagement type picks it: the `program`, the
`engagementType`, the `programEngagementTypeId`, the `args` a person gave that engagement type, the
`opportunity` with the `customerId` Siren matched it to (or null), the `triggeringCollaborator` and
the `cause`. The cause's `id` is the trigger's own random id, its `event` the engagement type that
fired, and its `occurredAt` the time the engagements the answer makes are dated. It answers
`AppEngagementCalculationAnswer`, `{ outcome: 'engagements', results }`, with at most 50 results,
each collaborator once and each in the organization and not in the trash, and each score a whole
number of 0 or more. An empty list makes no engagement.

A Customer filter for programs (`engagementFilter`) gets `AppEngagementFilterQuestion`, which names
the `collaborator` the engagement would credit. It answers `AppEngagementFilterAnswer`: allow the
engagement, or suppress it with a plain text reason of 1 to 200 characters, which Siren notes on the
opportunity.

Siren makes no engagement until the answer, and a sale on that program and opportunity waits for it
before it earns a reward. Siren waits 24 hours from the first ask at most. Then it stops waiting, the
trigger makes no engagement, the sales that waited award without it, and an answer after that gets
409 `app_request_dropped` (`AppErrorCode.Dropped`) as `ConflictError`.

```ts
const answers = appSiren.apps.requestHandler({ signingSecret });
answers.on('engagementCalculation', 'visit-weight', ({ data }) => ({
  outcome: 'engagements',
  results: [{ collaboratorId: data.triggeringCollaborator.id, score: data.opportunity.customerId ? 10 : 1 }],
}));
answers.on('engagementFilter', 'staff-check', ({ data }) =>
  crm.isStaff(data.collaborator.id) ? { outcome: 'suppress', reason: 'The visitor works for the partner.' } : { outcome: 'allow' },
);
```

### Answer a group structure ask

A Collaborator group structure (`collaboratorGroupStructure`) gets
`AppCollaboratorGroupStructureQuestion` once per cascade trigger on a group that picks it. The
question names the `group`, its `members` with each one's `collaboratorId`, `name` and `metadata`,
what the cascade is `for` (a program for an engagement cascade, a distributor for a metric cascade),
the `triggeringCollaborator` and the `cause`, whose `id` is the trigger's own random id of 16 hex
characters. It also carries the fields of the trigger it interrupts. A distributor's ask carries a
metric calculation's fields, typed as `AppCollaboratorGroupStructureDistributorQuestion`:

```json
{"group": {"id": 4, "name": "Northeast team"},
 "members": [{"collaboratorId": 42, "name": "Riley Rep", "metadata": {"rank": 3}},
             {"collaboratorId": 57, "name": "Sam Lead", "metadata": {"rank": 2}},
             {"collaboratorId": 63, "name": "Jo Manager", "metadata": {"rank": 1}}],
 "for": {"type": "distributor", "id": 2},
 "triggeringCollaborator": {"id": 42, "name": "Riley Rep"},
 "cause": {"id": "9f2c4e1a7b3d5c60", "type": null, "causeId": null},
 "distributor": {"id": 2, "name": "Partner leaderboard"},
 "distribution": {"id": 21, "periodEnd": "2026-12-01T00:00:00+00:00"},
 "metricType": "referredSiteVisit", "distributorMetricTypeId": 55,
 "opportunityId": 615, "points": null, "sale": null}
```

It answers `AppCollaboratorGroupStructureAnswer`, a chain or a tree. A chain's `order` lists every
member's `collaboratorId` once, top of the chain first, and Siren reads it as its built-in linear
chain. A tree's `parents` holds every member's `collaboratorId` as text once, each mapped to another
member's id or to null for a top member, with no cycle, and Siren reads it as its parent and child
structure. Siren refuses an answer that breaks these rules with 422 `app_answer_invalid`.

```ts
import type { AppCollaboratorGroupStructureAnswer } from '@novatorius/siren';

const chain: AppCollaboratorGroupStructureAnswer = { outcome: 'structure', shape: 'chain', order: [63, 57, 42] };
const tree: AppCollaboratorGroupStructureAnswer = {
  outcome: 'structure',
  shape: 'tree',
  parents: { '42': 57, '57': 63, '63': null },
};

const request = siren.apps.verifyRequest(rawBody, headers, signingSecret);
if (request.mode === 'ask' && request.item.kind === 'collaboratorGroupStructure') {
  await appSiren.apps.requests.answer(request.id, useTree ? tree : chain);
}
```

### Send a custom event

A custom event (`customEvent`) is an event of the app's own, such as a newsletter signup, that
programs and distributors credit. It declares the fields each send carries and its allowed domains,
the websites whose pages may send it from a visitor's browser:

```json
"newsletter-signup": {
  "kind": "customEvent",
  "name": "Newsletter signup",
  "fields": { "list": { "type": "string", "required": true } },
  "domains": ["example.com", "*.example.com"]
}
```

A domain is a host, such as `shop.example.com`, or `*.example.com` for every host under it. Siren
refuses a bare `*`, a scheme, a port and a path. With no domains, only the app's server can send the
event.

Siren takes only a short-lived token of the owning app at the event's address, never the key itself.
The SDK hides that. On the app's server, build the client with the app's key and send:

```js
const siren = new Siren({ apiKey: process.env.SIREN_API_KEY, baseUrl: process.env.SIREN_BASE_URL });

// A send from the app's server. The SDK trades the key for a short-lived
// token, keeps it and renews it, so this is all the code it takes.
export function recordSignup(collaboratorId, list) {
  return siren.events.ingest('newsletter-signup', { collaboratorId, list });
}

// The route a page asks for a browser token. Mount it at /siren/token.
export const browserTokens = siren.events.browserTokenHandler({ events: ['newsletter-signup'] });
```

`events.ingest` trades the key for a token that lasts 20 minutes at `POST /oauth/token`, keeps it,
gets a new one when fewer than two minutes are left, and after a 401 gets a new one and sends once
more. Sends at the same moment share one request. A key that belongs to no app sends with the key as
before. Sales, refunds and site visits keep sending the key.

A page sends the event with a browser token, which works for one event, lasts 10 minutes, and is
taken only from a page on the event's allowed domains. `browserTokenHandler()` answers a page's
request for one. It takes Node's `(req, res)` and a Web `Request`, so it mounts in one line:

```ts
app.post('/siren/token', browserTokens);       // Express
export const POST = browserTokens;              // Next.js app route, app/siren/token/route.ts
export default browserTokens;                   // Next.js pages route, pages/api/siren/token.ts
```

It reads the event from a JSON body `{"event": "newsletter-signup"}` or `?event=`, answers 200
`{token, expiresIn, url}`, 400 `{error}` for an event it doesn't offer or Siren refuses, and 502
when Siren can't be reached. `events.browserToken(eventKey)` answers the same object, for a server
that builds its own route. It keeps one token per event until fewer than 60 seconds are left.

On the page, `track` from the storefront module asks `/siren/token` for the token, keeps it until 30
seconds before it ends, and sends:

```js
import { track } from '@novatorius/siren/storefront';

export function wireSignupForm(form) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const collaboratorId = Number(form.dataset.collaboratorId);
    // track asks /siren/token for a browser token, keeps it, and sends.
    await track('newsletter-signup', { collaboratorId, list: 'weekly' });
  });
}
```

`track(eventKey, data, { tokenUrl })` resolves to Siren's answer, or `null` when the server gave no
token or Siren refused the send, and rejects on a network failure. `createTracker({ tokenUrl, fetch })`
gives a `track` with its own settings. Each send goes to Siren with the token in the query
(`?access_token=`) and no cookies.

Allowed domains stop another website's pages from sending the event, and a browser token from
sending any other event. They don't stop a program outside a browser that
asks your `/siren/token` for a token and claims an allowed `Origin`, or a visitor on an allowed page
who sends made-up data, so credit only what the event's fields can't fake. The examples/apps/signups folder holds a
whole app.

### See what Siren sent

`apps.requests.list({ status })` reads the latest 50 requests, newest first, and their status:
`pending`, `sent`, `delivered` (a tell the app received), `answered`, `applied` (an ask whose answer
did its work) or `needs_attention`. `apps.requests.retrieve(id)` reads one request, however old,
with `GET /apps/requests/{requestKey}`: the list's fields, the `data` Siren sent the app, the
`answer` Siren took or `null`, and `answeredByUser`, `{ id, email }` of the person who answered by
hand or `null`. It is a read, retried like one, and an admin's session only. Siren answers 404
`app_request_not_found` for a request the organization does not have. `apps.requests.resend(id)` sends a request again under the same
id with a new answer window. A request that holds an answer Siren has not applied, in
`needs_attention` after its apply ran out of tries or still `answered` because the wake after the
answer was lost, is not sent to the app again. Siren applies the stored answer instead, even while
the app is off. Siren refuses an `applied` request, and one it would have to send while its app is
off, with 409 `app_request_not_resendable`.

### Error codes

The app codes are in `AppErrorCode`, apart from `ErrorCode`, which holds Siren's shared list.
`appErrorCode(error)` reads the code from any app call's error.

```ts
import { AppErrorCode, appErrorCode, ConflictError } from '@novatorius/siren';

try {
  await siren.apps.delete('acme-payouts');
} catch (err) {
  if (err instanceof ConflictError && appErrorCode(err) === AppErrorCode.AppInUse) {
    await siren.apps.setStatus('acme-payouts', 'inactive');
  } else {
    throw err;
  }
}
```

| Code | Status | What to do |
|---|---|---|
| `app_limit_reached` | 403 | Turn another app off, or move to a plan with room. |
| `app_cap_reached` | 400 | The organization holds 250 apps, on or off. Delete one first. |
| `app_needs_a_part` | 422, 409 | Give the app a key, an address or both. |
| `app_items_need_key_and_address` | 422, 409 | An app with features needs a key and an address. `missing` names the part it lacks. |
| `app_key_exists` | 409 | Rotate the key instead of making one. |
| `app_key_missing` | 409 | Make a key with `apps.createKey()` first. |
| `app_address_missing` | 409 | Give the app a `url` first. |
| `org_access_required` | 403 | Ask an admin who sees every store. |
| `app_change_in_progress` | 409 | Send it again in a moment. |
| `app_in_use` | 409 | Turn the app off instead, or move the records in `uses` first. |
| `app_request_not_resendable` | 409 | Read the request. It is applied, or its app is off. |
| `app_request_already_answered` | 409 | Stop. A different answer came first, and it stands. |
| `app_request_not_needing_attention` | 409 | A person answered an ask that does not need attention. Wait for the app, or answer once `siren apps requests --attention` lists it. |
| `app_request_not_found` | 404 | Check the id. Siren tells an admin "This organization has no request with this key." and an app's key "No request with this key was sent to this app.", which also covers a request sent to another app. The resend route and `requests.retrieve()` say "App request not found." |
| `app_inactive`, `app_answer_forbidden` | 403 | Turn the app on, or answer as an admin. |
| `app_answer_invalid` | 422 | Fix the answer for the feature's kind. |
| `app_answer_unauthorized` | 401 | Answer with the app's own key or an admin's session. Siren sends this 401 with no code when the bearer is missing or unknown, and `requests.answer()` gives it the code and a message that says to run `siren apps rotate-key <app key>` when the app's key is lost, and `siren apps add-key <app key>` when the app holds no key, as after a revoke. |

### The sandbox

A sandbox key starts `sk_test_`. `new Siren({ apiKey })` sends one to `SANDBOX_BASE_URL` when you
give no `baseUrl`. It refuses a sandbox key with the live API's address and a live key with the
sandbox's, so a test never reaches a live organization. Any other address takes either kind, so a
local Siren works.

## Command-line tool

The package ships a `siren` command. It signs in with your Siren password, keeps the session on
your machine, and declares an app from a file, so you never handle a session token. Install the
package globally, or run it with `npx siren`.

```sh
siren signup                         # make an organization, or: siren login
siren apps init --key acme-payouts   # write siren.app.json
siren apps apply                     # show the changes, ask, declare the app, and save its key in .env.sandbox
siren apps requests --follow         # watch what Siren sends and what comes back
```

| Command | What it does |
|---|---|
| `siren signup` | Makes an organization and signs in. It asks for the organization's name, your email, the terms and a password, or takes `--org-name`, `--email`, `--accept-terms` and `--password-stdin`. |
| `siren login` | Signs in. `--org <slug or id>` picks one of your organizations. |
| `siren logout` | Signs out and forgets the session on this machine, even when Siren refuses. A session made when the Siren was the other edition is forgotten here and its tokens are not sent. |
| `siren orgs` | Lists your organizations, `*` on the one in use. |
| `siren use <slug or id>` | Switches to another of your organizations. |
| `siren apps init` | Writes siren.app.json, adds `.env.*` to .gitignore, and never overwrites a file. |
| `siren apps apply [file] [--yes]` | Reads the app on Siren first and prints each change the file would make: name, description, the address added, moved or removed (never its url), events, the key's scopes, and each feature added, changed, brought back or removed, with how many records select a removed one. It then asks before it writes, since the last write wins. `--yes` skips the question, and with no terminal and no `--yes` it sends nothing. With nothing to change it says so and writes nothing. It declares the app, then prints each feature's `app:{id}`. A feature the file no longer names while a record still selects it is archived: Siren keeps it, never calls it, and deletes it once nothing selects it. The command marks it beside the feature and says that naming it in the file again brings it back. On the first apply it saves the key, and the signing secret when the file names a `url`, in `.env.sandbox`, or `.env.live`, beside the file, and prints only the key's first 16 characters. |
| `siren apps list` | Lists the apps, their features and their events, and under an app with requests that need attention, how many and the `siren apps requests --app <key> --attention` that lists them. `--json` prints what Siren sent. |
| `siren apps show <key>` | Shows one app, its features and its events, with each archived feature marked beside it, and how many of its requests need attention when any do. |
| `siren apps requests` | Lists the requests, oldest first. `--app <key>` and `--attention` narrow the list, and `--follow` asks again every 2 seconds until Ctrl-C, and stops when the Siren becomes live or becomes a sandbox. With a request id, it shows each send with its HTTP status and the app's answer, and the body Siren sent. |
| `siren apps requests <id>` | Shows one request, however old: its line, the data Siren sent, the answer Siren took and who gave it, then each send with its HTTP status and what the app said back. |
| `siren apps answer <id>` | Answers an ask by hand, with `--body <json>` or `--file <path>`. A person may answer only a request that needs attention, which `siren apps requests --attention` lists. |
| `siren apps resend <id>` | Sends a request again. When Siren refuses because the request's app is off, it names the `siren apps on <key>` that turns it on. |
| `siren apps rotate-key <key>` | Gives the app a new key, which revokes the old one at once, and writes it as `SIREN_API_KEY` where apply wrote the first, or beside the file named by `--app-file`. It asks first, and `--yes` skips the question. |
| `siren apps rotate-secret <key>` | Gives the app's address a new signing secret and writes it as `SIREN_SIGNING_SECRET` the same way. Siren signs with it at once. It asks first, and `--yes` skips the question. |
| `siren apps add-key <key>` | Makes a key for an app that holds none and writes it as `SIREN_API_KEY` where apply wrote the first, or beside the file named by `--app-file`. The key holds no scopes until the next `siren apps apply`. |
| `siren apps rotate [<key>]` | Sends nothing, names `rotate-key` and `rotate-secret`, which replace it, and exits 1, with or without a key. |
| `siren apps on <key>` and `siren apps off <key>` | Turn the app on or off. |
| `siren apps delete <key> --yes` | Deletes the app and revokes its key. When records still use it, it names them, and the command to turn the app off while it is on, or that those records must change once it is already off. |

`list`, `show` and `apply` print `requires Pro`, or the plan Siren names, beside a feature or the
events the organization's plan cannot use, and say only that the plan cannot use it when Siren names
no plan. They read this from what Siren sends and never guess a plan. When the file names scopes
and the app holds no key, `apply` says so and names `siren apps add-key <key>`.

siren.app.json is a Siren recipe that holds one app, keyed by its app key, with its features in
`items`, keyed by feature key. `${SIREN_APP_URL}` in the app's `url` is filled from the environment,
from a variable whose name starts with `SIREN_APP_`, and only there. `url` is optional: a file with
no `url` declares a key-only app, which holds no features. A file with features and no `url` is
refused. A feature's kind and key lock once Siren makes it, so renaming a key makes a new feature
and archives or deletes the old one. The Payout method kind is `payoutMethod`, and the old
`fulfillmentMethod` is refused with a message that names it. A mistake in the file is printed with
its line and column, and nothing is sent.

The tool talks to `SIREN_BASE_URL`, else the sandbox. `--base-url <url>` names another Siren, and
takes plain http only for `localhost`, `127.0.0.1` and `host.docker.internal`. A live organization
needs `--live` on every command but `siren logout`, and `--live` against a sandbox is refused. Every
command that sends anything first asks the Siren whether it is a sandbox or live, and refuses a
session made when it was the other, so a sandbox session never reaches a Siren that became live.
The session lives in credentials.json in `SIREN_CONFIG_DIR`, else your config folder's `siren` folder,
readable by you alone. It never holds your password, an app's key or its secret. The tool answers 0
when it did what you asked, 1 when Siren or the tool refused, and 2 for a command line it cannot
read.

examples/apps/acme in this repository is a small app that checks each request, answers every ask,
and sends a sale with the app's own key. Its README walks through running it against the sandbox.

### Running against your own Siren Cloud

The `siren` command and an app work against a Siren Cloud you run yourself, such as the sandbox
stack in Siren's uat/sandbox/docker-compose.yml. That file as it ships leaves out four things an app
needs. Set them in a compose override on the `app` service:

| Setting | Why |
|---|---|
| `SIREN_SAAS_SIGNUP_ENABLED: "true"` | Without it, `siren signup` gets 404, since Siren answers the sign-up route only when sign-up is on. Build the image with `--build-arg SIREN_SAAS_SIGNUP_ENABLED=true` as well, so the dashboard offers it. |
| `SIREN_DURABLE_TASKS: "true"` | The sandbox file sets it to `"false"`, so no task worker starts and nothing can wait until later. An ask is sent once, but the wake that should follow when its answer window closes cannot be held, so the ask's job fails there. Siren never sends it again, and it never comes to need attention. With it on, the image starts its worker. |
| `SIREN_OUTBOUND_DEV_ALLOW_HOSTS: host.docker.internal` | Siren sends only to public https addresses. This lets it send to your app over plain http at that host name. Without it, `siren apps apply` with an http url gets `The URL must start with https://`. |
| `extra_hosts: ["host.docker.internal:host-gateway"]` | A Siren in a container reads `localhost` and `127.0.0.1` as the container itself, so it cannot reach a server on your machine there. Give the app's url as `http://host.docker.internal:8787`, and this line makes that name reach your machine on Linux. `siren apps apply` says so when the url names `localhost` or `127.0.0.1`. |

Siren's own build, `docker build -f saas/Dockerfile`, fetches private packages and needs a GitHub
token in `COMPOSER_AUTH`. Without one, run `composer install` in the Siren checkout so its vendor
folder is filled, and build the UAT image instead, which copies that folder:
`docker build -f uat/saas/Dockerfile --build-arg SIREN_EDITION=sandbox --build-arg SIREN_SAAS_SIGNUP_ENABLED=true -t siren-sandbox:local .`
That image seeds a UAT organization when it starts, so give the override `command:
/usr/local/bin/startup.sh`, Siren's ordinary start. Then point the tool at the stack with
`--base-url http://localhost:18090/siren/v1`, or `SIREN_BASE_URL`.

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
| `StoreKeyNotAllowedError` | A key bound to one store asked for payouts, fulfillments or webhook subscriptions (403, `code` `store_key_not_allowed`). Extends `PermissionError` |
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
