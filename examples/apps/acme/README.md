# Acme, an example Siren app

A small server that acts as part of Siren's engine. Siren tells it about each approved conversion of
a program that picks "Acme: Tell the CRM", asks it to pay each payout an autofulfiller sends through
"Acme: Acme ledger", and asks it to divide each pool a distributor splits with "Acme: Acme split".
It checks every request with `siren.apps.verifyRequest()` and answers every ask with
`siren.apps.requests.answer()`. The code that decides each answer is in handler.mjs.

| File | What it holds |
| --- | --- |
| siren.app.json | The app and its three items, which `siren apps apply` declares. |
| handler.mjs | The request handling: check, answer 200, drop a repeat by its `id`, answer each ask. |
| server.mjs | The HTTP server around handler.mjs, on `PORT`, 8787 by default. |
| env.mjs | Finds the env file `siren apps apply` wrote. |
| sale.mjs and send-sale.mjs | A visit and a sale with the app's own key, so you can make a conversion. |

Each ask item declares the shortest answer window Siren allows, one minute, so an ask nobody answers
needs attention after about three minutes: Siren sends it three times and waits one minute after
each send.

## Run it against the sandbox

From a checkout of this repository, with the `siren` command installed and signed in
(`siren signup` the first time, `siren login` after that):

1. Run `npm ci && npm run build` at the repository root, then `npm install` in this folder. The
   example takes the package from the checkout, so it runs in place.
2. In a second terminal, start a tunnel to port 8787, such as
   `cloudflared tunnel --url http://localhost:8787`, and keep the https address it prints.
3. Run `export SIREN_APP_URL=<that address>`, then `siren apps apply` in this folder. It declares
   the app, prints its items, and writes the app's key and signing secret to `.env.sandbox` in this
   folder, or `.env.live` for a live organization. Siren shows them once. Git ignores both files.
4. Run `npm start`. The server reads the env file apply wrote, so it talks to the Siren the app was
   applied to, and prints that address and the file. When both env files are here, set
   `SIREN_ENV_FILE` to the one to use.
5. In Siren's dashboard, pick "Acme: Tell the CRM" on a program, "Acme: Acme split" on a distributor,
   or "Acme: Acme ledger" on an autofulfiller, and give the program a collaborator.
6. Run `npm run send-sale -- tracking:<code> 49` with that collaborator's tracking code. It records a
   visit and a sale with the app's own key, which holds the `event:site-visited` and `event:sale`
   scopes, and prints how many conversions the sale made on which opportunity. A sale that made none
   prints Siren's reason, such as `no_program` when no active program accepts sales, and its message.
7. Watch what Siren sends and what came back with `siren apps requests --follow`. The server prints
   a line for each request it acts on and each answer Siren accepts.

Without a tunnel, set `SIREN_APP_URL` to any https address. Siren's deliveries then fail, and you
answer each ask by hand with `siren apps answer` once `siren apps requests --attention` lists it. A
person may answer only a request that needs attention.

## Before you copy it

The server keeps the ids it handled in memory, so after a restart it acts on a repeat again. A real
app keeps them in its own store, beside whatever it did for each request. An answer Siren did not
accept is not counted as handled, so the app answers again when Siren sends the ask again.
