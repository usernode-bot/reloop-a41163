# ReLoop — Return. Reuse. Reward.

A digital waste bank (bank sampah) for an Indonesian RT/RW neighborhood.
Residents bring sorted waste to the neighborhood waste bank; the waste bank
manager weighs it and records the deposit, points land in the resident's
balance, and residents redeem points for rewards. Managers set waste-type
prices, manage the roster and the reward catalog, and hand out redemptions.

## How it works

**Residents** (everyone signed in through Homeroom):

- **Home** — current points balance, how much has been recycled so far, the
  three most recent deposits, and how the loop works.
- **Deposits** — deposit history with the full per-waste-type breakdown.
- **Price list** — opened from Home: every waste type the waste bank accepts
  and its points per kilogram (or per item), read-only and always current.
- **Rewards** — the catalog with stock; redeem points and track the pickup
  (Waiting for pickup / Picked up / Cancelled — cancelled redemptions refund
  the points automatically).
- **Profile** — display name, house number and optional phone; plus the
  one-time **waste bank manager setup** (below).

**Waste bank managers** (the **Admin** tab):

- **Record deposit** — pick a member, add waste lines, save. Points are
  computed on the server from the current price and snapshotted, so later
  price edits never reprice old deposits.
- **Deposits** — everything recorded across the neighborhood, filterable by
  member; a mistyped deposit can be voided (blocked if the points were
  already spent, so a balance never goes negative).
- **Members** — the roster with balances; edit details, promote or demote
  managers (you can't demote yourself).
- **Prices** — waste types and their points per kilogram; retiring a type
  hides it from new deposits but keeps it on old ones.
- **Rewards** — the catalog: name, points cost, stock, show/hide.
- **Redemption queue** — mark pickups as handed over, or cancel (refund +
  restock).
- **Report** — the neighborhood at a glance: total waste collected, points
  issued and redeemed, the roster size, and a per-waste-type rollup. Voided
  deposits count nowhere.

## Becoming the first manager

The first manager promotes themselves once: on **Profile → Waste bank
manager setup**, enter the shared setup code. The code is the app's
`ADMIN_SETUP_CODE` secret, configured through the platform's Secrets UI —
agree on it with your neighborhood when the app is set up; it is never shown
in the app. After that, managers manage each other from the Members screen.

## Data conventions

- All point values are integers; weights are stored as **integer grams** —
  no floats anywhere.
- Per deposit line: `points = floor(weight_g × points_per_kg / 1000)`.
- Every balance change writes a `point_transactions` ledger row in the same
  transaction, so balances always reconcile.
- `members`, `deposits`, `deposit_items`, `redemptions` and
  `point_transactions` are **private** tables (`staging:private`): balances
  are financial data and phone numbers are personal. `waste_types` and
  `rewards` are public reference data.

## Out of scope for the MVP

Multiple waste banks per app instance, Rupiah/cash payouts, photo proof and
QR check-in, pickup scheduling, notifications, exports, resident
self-reporting of deposits, and offline mode.

## Running it

- `npm ci` then `npm run build` (compiles the Tailwind stylesheet).
- `npm start` — needs `DATABASE_URL`, and the platform-injected
  `USERNODE_*` variables when running inside Homeroom.
- `ADMIN_SETUP_CODE` — the manager setup secret (see above).
