// Starts the Signups example's server on PORT, 8787 by default:
//
//   npm start
//
// It answers POST /siren/token with a browser token for newsletter-signup,
// and POST /signup?collaboratorId=12 by sending the event from the server.
import { createServer } from 'node:http';
import { browserTokens, recordSignup } from './server.mjs';

const port = Number(process.env.PORT ?? 8787);

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/siren/token') return browserTokens(req, res);
  if (req.method === 'POST' && url.pathname === '/signup') {
    try {
      const result = await recordSignup(Number(url.searchParams.get('collaboratorId')), 'weekly');
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  res.writeHead(404).end();
}).listen(port, () => {
  console.log(`Signups example on http://localhost:${port}.`);
});
