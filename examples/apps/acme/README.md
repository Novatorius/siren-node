# Acme, an example Siren app

A small server that acts as part of Siren's engine. Siren tells it about each approved conversion of
a program that picks "Acme: Tell the CRM", asks it to pay each payout an autofulfiller sends through
"Acme: Acme ledger", and asks it to divide each pool a distributor splits with "Acme: Acme split".
It checks every request with `siren.apps.verifyRequest()` and answers every ask with
`siren.apps.requests.answer()`. The code that decides each answer is in handler.mjs.

## Run it against the sandbox

1. Sign in: `siren signup` the first time, `siren login` after that.
2. Start a tunnel to port 8787, such as `cloudflared tunnel --url http://localhost:8787`, and keep
   the https address it prints. Siren calls only a public https address.
3. In this folder, run `ACME_SIREN_URL=<that address> siren apps apply`. It declares the app, prints
   its items, and writes the app's key and signing secret to `.env.sandbox`. Siren shows them once.
4. Run `npm install`, then `npm start`.
5. In Siren, pick "Acme: Tell the CRM" on a program, or "Acme: Acme ledger" on an autofulfiller.
6. Watch what Siren sends and what came back with `siren apps requests --follow`.

Without a tunnel, Siren's deliveries fail. Answer each ask by hand with `siren apps answer` instead.
