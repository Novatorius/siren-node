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

Refunds and referred visits work the same way:

```ts
await siren.events.refund({ source: 'stripe', externalId: 'cs_test_a1b2c3' });
await siren.events.siteVisited({ collaboratorId: 88, userId: 12345 });
await siren.events.ingest('loyalty-points-earned', { userId: 42, points: 100 });
```

## Quickstart: verify a webhook

Siren signs every delivery with `X-Siren-Signature: sha256=<hmac>` — an HMAC-SHA256 of the raw
request body keyed by your subscription's signing secret. `constructEvent` verifies the signature
(constant-time) and parses the event in one call.

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
    );
  } catch (err) {
    if (err instanceof SignatureVerificationError) {
      return res.status(400).send('invalid signature');
    }
    throw err;
  }

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

Create the subscription (the `signingSecret` is returned **once** — store it):

```ts
import { WebhookEventType } from '@novatorius/siren';

const sub = await siren.webhooks.subscriptions.create({
  targetUrl: 'https://example.com/webhooks/siren',
  events: [WebhookEventType.ConversionApproved, WebhookEventType.PayoutPaid],
  // or: events: [WebhookEventType.All]
});
await saveSecretSomewhereSafe(sub.signingSecret);
```

## Features

- **Event ingestion** — record sales, refunds, referred visits, and custom event types
  (`events.sale`, `events.refund`, `events.siteVisited`, `events.ingest`). Ingestion is
  auto-retried on network errors and 429/5xx.
- **Signed-webhook verification and subscriptions** — constant-time signature checks
  (`webhooks.constructEvent`, `webhooks.verifySignature`) plus subscription management
  (`webhooks.subscriptions.create` / `list` / `delete`).
- **API keys** — mint, list, and revoke keys (`apiKeys.create` / `list` / `revoke`). The raw key
  is returned once and cannot be retrieved later.
- **Reconciliation reads** — thin paginated readers over Siren's ledger for `conversions`,
  `transactions`, `obligations`, and `payouts`.
- **Typed errors** — every failure throws a typed subclass of `SirenError` carrying `message`,
  `code`, and `statusCode` (`NotFoundError`, `RateLimitError`, `ValidationError`, and more).

```ts
const conversions = await siren.conversions.list({ page: 1, perPage: 50 });
console.log(conversions.estimatedCount); // total across all pages, if known

const key = await siren.apiKeys.create({ label: 'Production server' });
// key.rawKey (sk_live_...) is returned ONCE and cannot be retrieved later.
```

## Configuration

```ts
const siren = new Siren({
  apiKey: 'sk_live_...',                                 // required
  baseUrl: 'https://api.sirenaffiliates.com/siren/v1',   // default; point at staging/local as needed
  timeout: 30_000,                                       // ms, default 30s
  maxRetries: 2,                                         // default 2
});
```

Idempotent reads and event ingestion automatically retry network errors and 429/5xx responses with
exponential backoff (honoring `Retry-After`). Management writes — `apiKeys.create` and
`webhooks.subscriptions.create` — are **never** auto-retried, so a flaky connection can't mint
duplicate credentials.

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

Every failure throws a typed subclass of `SirenError`, each carrying `message`, `code`, and
`statusCode`. Catch the base class to handle any SDK error, or branch on a specific subclass:

| Error | When it's thrown |
|---|---|
| `AuthenticationError` | Missing or invalid API key (401) |
| `PermissionError` | Key lacks permission for the operation (403) |
| `NotFoundError` | The requested resource does not exist (404) |
| `ValidationError` | Request payload failed validation (422) |
| `BadRequestError` | Malformed request (400) |
| `ConflictError` | Conflicting state, e.g. a duplicate (409) |
| `RateLimitError` | Rate limit exceeded (429); honors `Retry-After` |
| `ApiError` | Unexpected server error (5xx) |
| `ConnectionError` | Network failure reaching Siren |
| `SignatureVerificationError` | A webhook signature did not verify |

```ts
import {
  Siren,
  SirenError,
  RateLimitError,
  ValidationError,
  NotFoundError,
} from '@novatorius/siren';

const siren = new Siren({ apiKey: process.env.SIREN_API_KEY! });

try {
  await siren.events.sale({ orderId: 'order_123', amount: 4999 });
} catch (err) {
  if (err instanceof RateLimitError) {
    // already retried with backoff; back off further or queue for later
  } else if (err instanceof ValidationError) {
    console.error('Invalid payload:', err.message, err.code);
  } else if (err instanceof NotFoundError) {
    // the order or program does not exist
  } else if (err instanceof SirenError) {
    console.error(`Siren error ${err.statusCode}:`, err.message);
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
