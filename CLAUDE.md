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

ReLoop ("Give. Swap. Reuse.") is a neighborhood app for keeping second-hand
things in use. Neighbors post what they no longer need (Free, Swap, or a low
price paid in person at pickup), others ask for it, and the owner accepts one
request and marks the handover done. Every completed handover is one loop kept
out of the waste stream. It replaces the old bank sampah deposit book: deposits,
points, prices, rewards, the leaderboard and the collection schedule are gone
from the app. Their tables are left in place and unused, so recorded history is
not destroyed.

## Design

- **Palette:** the kit's defaults: one teal accent on warm neutrals (stone
  greys), danger red for errors only. Designed **dark first**; people whose
  Homeroom theme is light get a legible light look, and outside Homeroom the app
  opens dark. No theme picker: the viewer's Homeroom setting is the control.
- **Signature element:** the photo-led item card in the Home feed: a square
  photo (or bundled category art) with the Free, Swap or price tag on it, then
  title, "Condition · Area" and the distance.
- **Type scale:** `text-title`, `text-heading`, `text-body`, `text-small`
  _(change their sizes in `tailwind.config.js` if you must, not their number)_
- **Components:** the kit in `styles/tailwind-input.css` plus one addition,
  `.chip`, a 44 px rounded filter/choice pill whose pressed state
  (`aria-pressed="true"`) takes the accent. Item cards are `.card` with `p-0`
  and a photo on top; grouped rows elsewhere use `.list`/`.list-row`.
- **Navigation:** bottom tab bar (`.tab-nav`/`.tab-btn`): Home, My Loops,
  Impact, Profile, and Moderate for moderators. Posting is a button on Home, not
  a tab. Statuses are `bg-raised` pill badges.
- **Words (fixed):** item, post, Post an item, Post item, photo, title, short
  description, condition (Like new, Good, Worn), category (Clothes,
  Electronics, Furniture, Books, Kitchen), pickup area, Free, Swap, Price (on the
  form), Cheap (the filter), request, Request this item, Accept, Decline, Mark
  as done, Make available again, Cancel request, status (Available, Reserved,
  Done), My Loops, My Items, My Requests, loop, Impact, items reused, estimated
  kg of waste avoided, badge, Report this item, moderator, Moderate, Hide item,
  Keep, Hidden by a moderator.
- Colour comes only from the tokens; never a raw hex value or a stock palette
  class. Tap targets are at least 44 px. Every screen that loads data has honest
  loading, empty and error states. No cards in cards, no uppercase eyebrows, no
  emoji as icons.

## App-specific conventions

- **One neighborhood, eight pickup areas.** `AREAS` is `RT 01` to `RT 08` in
  `server.js` and is returned by `GET /api/me`; never duplicate it in the
  client. Distance is counted in blocks between areas, never from the phone's
  location, and nothing shows until the viewer sets an area.
- **Estimates, always labelled.** `EST_GRAMS` (clothes 500, electronics 2000,
  furniture 15000, books 1000, kitchen 1000) is a typical weight per category in
  integer grams. Any "kg of waste avoided" figure must say it is an estimate.
  A completed loop is an item with `status = 'done'`: it counts once for its
  owner and once for the accepted requester.
- **Owners and requesters are Homeroom user ids, stored without a foreign key**
  (`owner_user_id`, `requester_user_id`, `reporter_user_id`), matching
  `members.user_id`. That is what lets a later account-deletion handler find
  their rows. Public tables (`items`, `item_photos`) must never hold a foreign
  key into a private table.
- **Private tables:** `members`, `item_requests`, `item_reports` are
  `staging:private` (request messages and moderation). `items` and
  `item_photos` are public.
- **One request per person per item.** The owner accepts one; other pending
  requests stay pending so a fallback pickup is possible. Accepting and
  cancelling take a row lock on the item so two taps cannot both win. A done
  loop cannot be cancelled or reopened.
- **Photos:** at most 3 per item, shrunk client-side (longest side 1600 px,
  JPEG 0.85) and uploaded with `usernode.uploadFile()` before the item is
  posted. Persist only the returned URL and id; never image bytes. A missing or
  failed photo falls back through `img.onerror` to `/art/<category>.svg`. Seed
  rows carry no photo rows, so category art shows.
- **Moderation:** the old waste bank manager role is the moderator role, with
  the same one-time `ADMIN_SETUP_CODE` setup on Profile. Moderators review
  reports and can hide an item (it leaves the feed for everyone but its owner and
  moderators), promote and demote each other, and never demote themselves.
  Reports key on the item; hiding does not delete photo files.
- **Seeded staging data uses fake member ids `910001` to `910006`**, kept away
  from the ids the platform uses for whoever opens a preview. Never seed a row
  owned by the viewer, and never a signal the app's own logic reads.
- **Price listings** carry an IDR amount (Rp 1,000 to Rp 1,000,000) paid in
  person at pickup. ReLoop handles no payments and stores no payment data.
- UI copy is English with Indonesian neighborhood terms (RT, Rp); a full Bahasa
  Indonesia pass would go through `req.user.locale`.
