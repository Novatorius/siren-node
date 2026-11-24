/*
 * DX pass 2, finding 1, for the editor: `on()` takes only a kind Siren
 * sends, and a kind named in `extraKinds`. Finding 3: an ask's function
 * returns its answer or `answers.later()`, never nothing. Only
 * `npm run typecheck` reads this file, and each `@ts-expect-error` fails
 * it when the line beneath type-checks.
 */
import { Siren } from '../../src/client';
import type { AppFeatureFunctions } from '../../src/record-types';
import type { FeatureKind } from '../../src/taxonomy';

const siren = new Siren({ apiKey: 'sk_live_x' });
const answers = siren.apps.requestHandler();

answers.on('distributionResolver', 'split-by-score', ({ data }) => ({ outcome: 'allocated', units: data.pool.units, shares: {} }));
answers.on('payoutMethod', () => answers.later());
answers.on('postConversionAction', async () => {});

// @ts-expect-error a misspelled kind
answers.on('distributionResolvr', () => answers.later());
// @ts-expect-error Siren never sends a custom event
answers.on('customEvent', 'signup', () => undefined);
// @ts-expect-error an ask's function that forgets to return
answers.on('distributionResolver', 'split-by-score', () => {
  void 0;
});
// @ts-expect-error an ask's function that returns undefined
answers.on('payoutMethod', async () => undefined);

const newer = siren.apps.requestHandler({ extraKinds: ['brandNewKind'] });
newer.on('brandNewKind', 'a-key', () => ({ outcome: 'done' }));
newer.on('distributionResolver', () => newer.later());
// @ts-expect-error a kind extraKinds does not name
newer.on('anotherNewKind', () => newer.later());

/** The kinds `on()` takes are FeatureKind without customEvent, both ways round. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameKinds: Same<keyof AppFeatureFunctions, Exclude<FeatureKind, 'customEvent'>> = true;
void sameKinds;
