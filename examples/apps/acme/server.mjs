// The Acme example app: a small server that checks each request Siren sends
// and answers every ask. Start it after `siren apps apply`:
//
//   npm start
//
// It reads the env file apply wrote (see env.mjs), so it talks to the Siren
// the app was applied to. It listens on PORT, 8787 by default.
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Siren } from '@novatorius/siren';
import { loadAppEnv } from './env.mjs';
import { createAcmeApp, createRequestListener } from './handler.mjs';

let path, values;
try {
  ({ path, values } = loadAppEnv(dirname(fileURLToPath(import.meta.url)), process.env));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const siren = new Siren({ apiKey: values.SIREN_API_KEY, baseUrl: values.SIREN_BASE_URL });
const log = (line) => console.log(line);
const app = createAcmeApp({ siren, signingSecret: values.SIREN_SIGNING_SECRET, log });
const port = Number(process.env.PORT ?? 8787);

createServer(createRequestListener(app, log)).listen(port, () => {
  console.log(`Acme example app on http://localhost:${port}, for ${values.SIREN_BASE_URL} (${path}).`);
});
