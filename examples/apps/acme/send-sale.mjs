// Sends one sale for a collaborator with the app's own key:
//
//   node send-sale.mjs <collaborator id or tracking:code> [total]
//
// It reads the env file `siren apps apply` wrote (see env.mjs).
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Siren } from '@novatorius/siren';
import { loadAppEnv } from './env.mjs';
import { sendSale } from './sale.mjs';

const [collaborator, total = '49.00'] = process.argv.slice(2);
if (!collaborator) {
  console.error('Usage: node send-sale.mjs <collaborator id or tracking:code> [total]');
  process.exit(2);
}
let path, values;
try {
  ({ path, values } = loadAppEnv(dirname(fileURLToPath(import.meta.url)), process.env));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const siren = new Siren({ apiKey: values.SIREN_API_KEY, baseUrl: values.SIREN_BASE_URL });
let result;
try {
  result = await sendSale(siren, {
    collaborator: /^\d+$/.test(collaborator) ? Number(collaborator) : collaborator,
    total: Number(total),
    currency: 'USD',
    externalId: `acme-${Date.now()}`,
  });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
console.log(`Sent a sale of ${total} USD through ${path}: ${result.status ?? 'sent'}, opportunity ${result.opportunityId ?? 'none'}.`);
