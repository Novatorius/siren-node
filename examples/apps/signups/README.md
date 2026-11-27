# Signups, a custom event example

An app with one custom event, `newsletter-signup`, which it sends to Siren two ways:

- from its server, with `siren.events.ingest()`, which trades the app's key for a short-lived token
  behind the scenes, and
- from its pages, with `track()` from `@novatorius/siren/storefront`, which asks the app's server for
  a browser token at `/siren/token`.

| File | What it holds |
| --- | --- |
| siren.app.json | The app and its custom event, with its fields and its allowed domains. It needs no url, since Siren never calls it. |
| server.mjs | The server send and the browser token route. |
| page.mjs | The page send, for a page on one of the allowed domains. |
| start.mjs | An HTTP server around server.mjs, on `PORT`, 8787 by default. |

## Run it against the sandbox

1. Run `npm ci && npm run build` at the repository root, then `npm install` in this folder.
2. Run `siren apps apply` in this folder. It declares the app and writes its key to `.env.sandbox`.
3. Run `npm start`, then `curl -X POST 'http://localhost:8787/signup?collaboratorId=12'` with the
   id of one of your collaborators.

A page can send the event only from a domain the event allows. Edit `domains` in siren.app.json and
apply again to change them, or change them on the event's feature page in Siren.
