# ReLoop

A digital waste bank for neighborhoods (RT/RW). Households record the
recyclable waste their members bring in — plastic, paper, metal, glass and
other — and every member's running point balance is kept in one place,
replacing the paper ledger waste banks usually keep by hand.

## How it works

- **Sign-in** — everyone signs in through Homeroom automatically; the app
  builds no accounts of its own. Visitors without a Homeroom account can
  look around, but recording asks them to make an account first.
- **Households** — one person creates a household (an RT or RW group) and
  neighbours join it from the list on the start card. Everyone belongs to
  exactly one household; duplicate names are allowed, and the list shows
  member counts so you can tell them apart.
- **Deposits** — "Record a deposit" saves who brought the waste, its type
  and its weight in kilograms (up to one decimal, more than 0 and at most
  500). Anyone in the household can log a drop-off for anyone in it.
- **Points** — 1 point per full kilogram deposited. A deposit under a full
  kilogram earns no points yet, and fractions do not carry over between
  deposits. Balances are per member, ordered by points, highest first.
- **Permanent** — deposits are never edited or deleted; the book only grows.

## Under the hood

- **Data model** — three append-only tables: `households`, `members` and
  `deposits`. Weights are stored as integer grams (`weight_grams`), never
  floats; points are whole numbers.
- **API** — Express routes under `/api`: list households, create or join a
  household, read your household and its balances (`/api/my-household`),
  record a deposit. Errors come back as `{ error: message }`.
- **Database** — the app's own private Postgres.
- **Styling** — Tailwind CSS, precompiled by `npm run build` during the
  image build with either Kubernetes/Paketo or standalone Docker, in a light
  and a dark look that follow the viewer's Homeroom theme.
- **Staging** — a boot-time seed inserts two clearly fake demo households
  ("Staging demo: …") with fake members and deposits, so the screen can be
  seen populated; production starts empty.

## Changing this app

Open the app on Homeroom, tap the Homeroom icon in the header, then
**Suggest an improvement**, and describe what you'd like in plain English.
You can also run Claude Code against this repo directly; start with
`CLAUDE.md`, which carries the app-specific notes and points at the
platform rules.
