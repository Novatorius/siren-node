# Acme, an example Siren app

A small server that acts as part of Siren's engine. Siren tells it about each approved conversion of
a program that picks "Acme: Tell the CRM", asks it to pay each payout an autofulfiller sends through
"Acme: Acme ledger", and asks it to divide each pool a distributor splits with "Acme: Acme split".
It checks every request with `siren.apps.verifyRequest()` and answers every ask with
`siren.apps.requests.answer()`. The code that decides each answer is in handler.mjs.

Each ask item declares the shortest answer window Siren allows, one minute, so an ask nobody answers
needs attention after about three minutes: Siren sends it three times and waits one minute after
each send.

## Run it against the sandbox

From a checkout of this repository, with the `siren` command installed and signed in
(`siren signup` the first time, `siren login` after that):

1. Run `npm ci && npm run build` at the repository root, then `npm install` in this folder.
2. In a second terminal, start a tunnel to port 8787, such as
   `cloudflared tunnel --url http://localhost:8787`, and keep the https address it prints.
3. Run `export SIREN_APP_URL=<that address>`, then `siren apps apply`. It declares the app, prints
   its items, and writes the app's key and signing secret to `.env.sandbox` in this folder, or
   `.env.live` for a live organization. Siren shows them once.
4. Run `npm start`. The server reads the env file apply wrote, so it talks to the Siren the app was
   applied to. When both env files are here, set `SIREN_ENV_FILE` to the one to use.
5. In Siren's dashboard, pick "Acme: Tell the CRM" on a program, "Acme: Acme split" on a distributor,
   or "Acme: Acme ledger" on an autofulfiller, and give the program a collaborator.
6. Run `npm run send-sale -- tracking:<code> 49` with that collaborator's tracking code. It records a
   visit and a sale with the app's own key, which holds the `event:site-visited` and `event:sale`
   scopes.
7. Watch what Siren sends and what came back with `siren apps requests --follow`.

Without a tunnel, set `SIREN_APP_URL` to any https address. Siren's deliveries then fail, and you
answer each ask by hand with `siren apps answer`.
