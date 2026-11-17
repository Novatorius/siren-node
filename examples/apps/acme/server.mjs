// The Acme example app: a small server that checks each request Siren sends
// and answers every ask. Run it with the env file `siren apps apply` wrote:
//
//   npm install
//   node --env-file=.env.sandbox server.mjs
//
// It listens on PORT, 8787 by default. Siren reaches only a public https
// address, so put a tunnel in front of it (see README.md).
import { createServer } from 'node:http';
import { Siren } from '@novatorius/siren';
import { createAcmeApp } from './handler.mjs';

const apiKey = process.env.SIREN_API_KEY;
const signingSecret = process.env.SIREN_SIGNING_SECRET;
if (!apiKey || !signingSecret) {
  console.error('Set SIREN_API_KEY and SIREN_SIGNING_SECRET. `siren apps apply` writes both to .env.sandbox.');
  process.exit(1);
}

const siren = new Siren({ apiKey, ...(process.env.SIREN_BASE_URL ? { baseUrl: process.env.SIREN_BASE_URL } : {}) });
const app = createAcmeApp({ siren, signingSecret, log: (line) => console.log(line) });
const port = Number(process.env.PORT ?? 8787);

createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    const reply = await app.handle(Buffer.concat(chunks), req.headers);
    res.writeHead(reply.status, { 'Content-Type': 'application/json' });
    res.end(reply.body);
  });
}).listen(port, () => {
  console.log(`Acme example app listening on http://localhost:${port}`);
});
