# ReLoop — Return. Reuse. Reward.

A neighborhood exchange for an Indonesian RT/RW community. Neighbors post
things they no longer need — offered free, to swap, or cheap — and ask each
other for them, so usable goods move to a new home instead of becoming waste.

## What people can do

**Home** is the feed: the neighborhood's items, newest first, with a photo,
title, condition and how far the pickup area is from your own. Filter by
category (clothes, electronics, furniture, books, kitchen) and by type
(Free, Swap, Cheap).

**Post an item** takes up to three photos, a title, a short description, the
condition (like new, good, worn), a category, the pickup area (the RT) and
whether it is Free, Swap or Cheap (with a rupiah price).

**Item detail** shows the photos, description and who posted it. Anyone else
can press **Request this item** and send the owner a short message; the owner
accepts (the item becomes Reserved) or declines. The owner marks it Done once
it has changed hands.

**My Loops** holds the two sides of your activity: My items (with their
status — Available, Reserved, Done — and how many requests are waiting) and
My requests (with their answer).

**Impact** counts the loops you completed and the kilograms of waste they
kept out of the bin, with a badge for every five completed loops.

**Profile** sets your pickup area, which the feed uses to show distance.

Every item also has a **Report** action; a post reported by three different
neighbors is hidden everywhere except from its owner until it is reviewed.

## Data conventions

- Items carry an estimated weight in **integer grams**, taken from their
  category, so Impact can report kilograms without asking anyone to weigh
  anything.
- `items` and `item_photos` are public (the neighborhood's listings);
  `profiles`, `item_requests` and `item_reports` are private
  (`staging:private`).
- Photos live in the platform's file storage; the app stores only their URLs.
- The tables of the earlier waste-bank product (members, deposits, rewards,
  …) are kept so existing history is never destroyed, but nothing reads them
  any more.

## Running it

- `npm ci` then `npm run build` (compiles the Tailwind stylesheet).
- `npm start` — needs `DATABASE_URL`, and the platform-injected
  `USERNODE_*` variables when running inside Homeroom.
