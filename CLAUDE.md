# ReLoop — notes for Claude Code

This app runs on **Homeroom**. If you're Claude Code
editing this repo, read the platform conventions before making
changes:

**Platform conventions (authoritative, always current):**
https://app.onhomeroom.com/claude.md

Fetch that URL at the start of each session — it's the single source
of truth for platform-wide behavior (auth model, `USERNODE_ENV`,
public/private tables, "don't `git push`", etc.). The hosted copy is
updated in place when platform rules change, so fetching it gives you
today's rules, not a stale snapshot.

When running inside Homeroom's dev-chat, those same conventions are
already injected into your system prompt, so the fetch is a no-op in
that path — but it's the right reflex when someone runs Claude Code
against this repo locally or from another harness.

## Connector permission prompts

This repo ships `.claude/settings.json`, which allows the **read-only**
Homeroom connector calls (`mcp__homeroom__get_*`,
`…__list_*`, `…__whoami`) so they stop prompting one at a time. Everything
that acts — filing a request, opening or advancing a proposal — still asks.
Claude Code applies those rules only after you accept the
workspace trust dialog, which lists them for review. See `.claude/README.md`
for the whole story, including what to do if you are still being prompted
(usually: your connector is registered under a different name than the rules
assume).

## Check that this checkout is current

You may be working in a fork of this app whose `main` is behind the app's
canonical repository, and nothing in the checkout says so: `git fetch origin`
compares the fork with itself. This matters before you **read** code to answer
a question about how the app behaves now, not only before you edit it.

The canonical repository is named in `.claude/homeroom-canonical-repo`. Check against
it, not against `origin`:

```sh
git fetch "$(cat .claude/homeroom-canonical-repo)" main
git merge-base --is-ancestor FETCH_HEAD HEAD && echo current || echo behind
```

`behind` means this checkout does not contain the canonical `main`. To answer
a question, read the canonical code instead (`git show FETCH_HEAD:<path>`,
`git grep <pattern> FETCH_HEAD`). To change code, start from the exact base
commit your Homeroom work order gives, and never merge or rebase onto the
canonical `main` yourself: which commit a change is diffed against decides
what the group votes on. With the Homeroom connector, `get_checkout_status`
answers the same question.

A session-start hook (`.claude/hooks/homeroom-freshness.sh`, see `.claude/README.md`) runs
this check for you and tells you when you are behind. It is silent offline, so
its silence is not proof the checkout is current. Inside Homeroom's dev-chat
the platform fixes the base commit, and none of this applies.

## Starter template

The screen this app currently ships — the hero, the "What's already
working" card, and the Press! example (the demo markup in
`public/index.html`, the `/api/press` and `/api/leaderboard` routes, and
the `presses` table bootstrap in `server.js`) — is placeholder content
from the Homeroom starter template, not product intent.

When the user asks for their first real feature, REPLACE the template
screen rather than building alongside it:

- remove the `usernode-starter-notice@1` block in `public/index.html`
  (both sentinel comments and everything between them),
- remove or repurpose the "Try the example" card, its demo endpoints and
  the `presses` table as appropriate,
- rewrite `README.md` to describe the actual app.

Keep the `usernode-dev-console@1` forwarder `<script>` when rewriting the
HTML — that block is platform infrastructure, not template content. So is
the bridge `<script>`. The design kit is not placeholder either: build the
real app with it, and fill in "## Design" below.

The screen has a light and a dark look and follows the viewer's Homeroom
theme, switching live when they change it: the theme `<script>` right after
the bridge tag sets a `dark` class on `<html>`. Keep that script, and give
everything you build both looks (the design kit's colour tokens carry both), unless one
fixed look is the point of this app, like a game's own scene; then say so
under "## Design" below. Unless a request asks for one, add
no theme picker: the viewer's Homeroom setting is the control. "The
platform's light/dark theme inside the app frame" in the platform
conventions has the details.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About ReLoop

Digital waste bank app for neighborhoods to track and manage recyclable waste

ReLoop ("Return. Reuse. Reward.") is the deposit book of a bank sampah — an
Indonesian RT/RW neighborhood waste bank — in app form. Residents bring
sorted waste to the waste bank, the waste bank manager weighs it and records
the deposit, points land in the resident's balance, and points are redeemed
for rewards picked up at the waste bank. The manager owns the prices, the
roster and the catalog; residents own their history and balance.

## Design

This app's look. The first real version fills in the blanks; every later
change follows it, and updates it when a request changes the look on purpose.

- **Palette:** the kit's defaults, kept: one teal accent on warm neutrals
  (stone greys); danger red for errors only. Suits the recycling subject —
  no re-theming was wanted.
- **Signature element:** the Home points card — a full-width card with the
  balance in `text-title` and a small looping-arrows mark, reading like the
  deposit book of a bank sampah.
- **Type scale:** `text-title`, `text-heading`, `text-body`, `text-small`
  _(change their sizes in `tailwind.config.js` if you must, not their number)_
- Navigation is a bottom tab bar (`.tab-nav`/`.tab-btn`, the kit's only added
  component): Home, Deposits, Rewards, Profile, plus Admin for managers.
  Statuses are `bg-raised` pill badges; the words are fixed: Points, deposit,
  waste type, price, reward, redeem, redemption, stock, balance, member,
  waste bank manager, void.

The kit is in `styles/tailwind-input.css`: colour tokens with a light and
a dark value (named in `tailwind.config.js`), and a few components
(`btn-primary`, `btn-secondary`, `field`, `list` and `list-row`,
`card`, `section-label`, `skeleton`, `state-empty`, `state-error`).
Re-theme by changing the token values there, keeping every text pair at
4.5:1 or more in both looks.

- Colour comes only from the tokens (`bg-ground`, `bg-surface`,
  `text-fg`, `text-muted`, `border-line`, `bg-accent` with
  `text-on-accent`, ...): never a raw hex value or a stock palette class.
- Tap targets are at least 44 px; the buttons and fields already are.
- Every screen that loads data has honest loading, empty and error states.
  Never show the empty state while loading or after a failure; an error says
  what failed, what still works, and offers Retry.
- Seed obviously fake staging demo data so the populated screen can be seen
  ("Staging mock data" in the platform conventions).
- No cards in cards, no uppercase eyebrows, no emoji as icons.

## App-specific conventions

- **Integers only for points and weights.** Point values are integers;
  weights are stored as **integer grams** in `deposit_items.weight_g`. UI
  inputs are kilograms with decimals and convert to grams; never store a
  float.
- **Points are computed server-side** at record time:
  `points = floor(weight_g × points_per_kg / 1000)`, snapshotted onto
  `deposit_items` and `deposits`. Price edits never reprice history.
- **Every balance change writes a `point_transactions` ledger row in the
  same transaction** as the balance update. Balances never go negative:
  voids and refunds check the balance first.
- **Private tables:** `members`, `deposits`, `deposit_items`, `redemptions`,
  `point_transactions` are `staging:private` (balances are financial data,
  phone numbers personal). `waste_types` and `rewards` stay public. The
  Home leaderboard ranks **kilograms only, first names only**, with an
  opt-out on Profile (`members.leaderboard_opt_out`) — it never shows a
  points balance, a house number or a full name.
- **The first waste bank manager** promotes themselves once with
  `ADMIN_SETUP_CODE` (a dapp.json secret) on the Profile screen; after that,
  managers promote/demote each other, and self-demotion is refused so the
  neighborhood can't lock itself out of admin.
- **Deposits are recorded by managers only**; residents never record their
  own (no self-reporting in the MVP).
- **One neighborhood per app instance** — no multi-bank support; don't add a
  bank/waste-bank dimension to the schema without revisiting every table.
- UI copy is English with Indonesian domain terms (bank sampah, RT/RW); a
  full Bahasa Indonesia pass would go through `req.user.locale`.
