// The Signups example's server half: one custom event, newsletter-signup,
// sent from the app's server and handed to its pages as a browser token.
// The package README shows the part between the README markers, and a test
// runs it.
import { Siren } from '@novatorius/siren';

// README: server
const siren = new Siren({ apiKey: process.env.SIREN_API_KEY, baseUrl: process.env.SIREN_BASE_URL });

// A send from the app's server. The SDK trades the key for a short-lived
// token, keeps it and renews it, so this is all the code it takes.
export function recordSignup(trackingId, list) {
  return siren.events.ingest('newsletter-signup', { collaborator: { trackingId }, list });
}

// The route a page asks for a browser token. Mount it at /siren/token.
export const browserTokens = siren.events.browserTokenHandler({ events: ['newsletter-signup'] });
// README end
