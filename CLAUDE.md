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

A neighborhood exchange for giving, swapping and selling second-hand items,
so usable goods stay in use instead of becoming waste.

ReLoop ("Return. Reuse. Reward.") is an Indonesian RT/RW neighborhood's
exchange in app form. A neighbor posts something they no longer need — free,
to swap, or cheap — with up to three photos, a condition and the RT where it
can be picked up. Other neighbors browse the feed, open an item and send the
owner a short message asking for it; the owner accepts (the item is Reserved)
or declines. When it has changed hands the owner marks it Done. Each completed
"loop" counts in Impact: items reused, estimated kilograms of waste avoided,
and a badge every five loops. One post is one loop; the feed, My Loops and
Impact are the whole product.

## Design

This app's look. Every change follows it, and updates it when a request
changes the look on purpose.

- **One fixed dark look, deliberately.** The product was asked for a dark
  theme, so both the `:root` and `.dark` token sets in
  `styles/tailwind-input.css` carry the same warm dark values and the theme
  script in `public/index.html` just adds `.dark` and sets
  `color-scheme: dark`. Do not add a light look or a theme picker without a
  request that asks for one.
- **Palette:** one teal accent (`--accent`) on warm dark neutrals; danger red
  for errors only. Category marks and photos carry the only other colour.
- **Signature element:** the feed card — a photo tile with the type pill
  (Free in the accent, Swap/Cheap on the surface) over its top-left corner,
  the title under it and one muted line: condition · area · distance. Two
  columns on a phone.
- **Type scale:** `text-title`, `text-heading`, `text-body`, `text-small`
  _(change their sizes in `tailwind.config.js` if you must, not their number)_
- Navigation is a bottom tab bar (`.tab-nav`/`.tab-btn`): Home, Post, Loops,
  Impact, Profile.
- The words are fixed: item, post, request, loop, Free, Swap, Cheap, like new,
  good, worn, Available, Reserved, Done, pickup area, waste avoided.

The kit is in `styles/tailwind-input.css`: colour tokens (named in
`tailwind.config.js`), and a few components (`btn-primary`, `btn-secondary`,
`field`, `list` and `list-row`, `card`, `section-label`, `chip`, `skeleton`,
`state-empty`, `state-error`). Re-theme by changing the token values there,
keeping every text pair at 4.5:1 or more.

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

- **Integers only for money and weights.** Prices are whole rupiah; an
  item's estimated weight is **integer grams** in `items.weight_g`. Never
  store a float.
- **The weight estimate comes from the category** (`CATEGORY_WEIGHT_G` in
  `server.js`) and is snapshotted on the item when it is posted, so Impact's
  kilograms never move when the estimate changes later.
- **Private tables:** `profiles`, `item_requests` and `item_reports` are
  `staging:private` (a pickup area is personal, a request is a one-to-one
  message, a report names its reporter). `items` and `item_photos` stay
  public — they are the neighborhood's listings.
- **Statuses are server-owned.** `available → reserved → done`, changed only
  by the owner: accepting a request reserves the item, `release` frees it
  again, and `complete` marks it done (and completes the accepted request).
  Every transition runs in one locked transaction.
- **Distances are walked, not located.** Pickup areas are the RTs of the one
  neighborhood (`ZONES`), laid along its street; the walk between neighboring
  RTs is `ZONE_SPACING_M` (150 m). The feed turns the viewer's own pickup
  area into "≈ N m"; with no area set it shows the area only. No geolocation,
  no stored coordinates.
- **Completed loops:** an item marked done that the person posted or
  received (`owner_id` or `reserved_for`). Impact counts those; a badge is
  earned every 5.
- **Photos are platform storage only.** The page uploads with
  `usernode.uploadFile()` and the server stores just the returned https URL
  (max 3 per item). Never image bytes in Postgres. Outside the platform shell
  uploads are unavailable and the form still posts without photos.
- **Reporting:** any non-owner can report an item once; three distinct
  reporters hide it (`items.hidden`) from the feed and from everyone but its
  owner. Hidden items never appear in a list.
- **One neighborhood per app instance** — no multi-neighborhood support;
  don't add a neighborhood dimension to the schema without revisiting every
  table.
- The earlier waste-bank tables (`members`, `deposits`, `rewards`, …) are
  kept only so existing history is not destroyed. Nothing reads them; do not
  build on them, and keep `usernode-user-data.js` erasing a person's rows
  there.
- UI copy is English with Indonesian domain terms (RT/RW); a full Bahasa
  Indonesia pass would go through `req.user.locale`.
