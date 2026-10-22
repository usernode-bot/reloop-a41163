# ReLoop

Give. Swap. Reuse.

ReLoop is the neighborhood's reuse board: a place where neighbors give away,
swap or cheaply sell second-hand things so they stay in use instead of becoming
waste. It runs on [Homeroom](https://app.onhomeroom.com); people sign in through
the platform, and the app is one neighborhood, RT 01 to RT 08.

## Screens

- **Home**: a two-column feed of nearby items, each with a photo, title,
  condition and pickup area, and how far that is from your own area. Filter by
  category (Clothes, Electronics, Furniture, Books, Kitchen) and by type (Free,
  Swap, Cheap). **Post an item** is the primary action.
- **Post an Item**: up to 3 photos, title, short description, condition, category,
  pickup area and Free, Swap or Price. Photos are shrunk in the browser and
  uploaded to Homeroom's file storage; posting without photos shows bundled
  category art instead.
- **Item Detail**: photos, description, owner and distance. Ask for the item with
  a short message, cancel your request, or report the item. The owner sees the
  requests and accepts one, which reserves the item; they then mark the handover
  done or make it available again.
- **My Loops**: **My Items** and **My Requests**, with each item's status
  (Available, Reserved, Done) and where each request stands.
- **Impact**: your completed loops, an estimate of the kilograms of waste they
  avoided (typical weight per category), a badge for every 5 loops, and the same
  two figures for the whole neighborhood.
- **Profile**: display name and pickup area, plus the one-time moderator setup.
- **Moderate** (moderators only): reported items to hide or keep, and the roster
  of moderators.

Distance is derived from fixed pickup areas, not from location tracking: an item
in the same area reads "In your area", otherwise a number of blocks between
areas. Until you set your pickup area, items show only their area.

## Moderation

People post text and photos, so every item that is not your own offers **Report
this item** with a reason and an optional note. The neighborhood's moderators
(the old waste bank manager role, promoted with `ADMIN_SETUP_CODE`) review
reports in Moderate and can **Hide item**, which removes it from the feed for
everyone except its owner, or **Keep** it. Moderators promote and demote each
other and cannot demote themselves.

## Data model

| Table | Contents | Privacy |
| --- | --- | --- |
| `items` | posted items; owners are Homeroom user ids, no FK | public |
| `item_photos` | stored photo URLs and positions, up to 3 per item | public |
| `item_requests` | a neighbor's message and its status | `staging:private` |
| `item_reports` | reports of an item and how a moderator resolved them | `staging:private` |
| `members` | display name, pickup area, moderator flag | `staging:private` |

The old waste bank tables (`waste_types`, `rewards`, `deposits`,
`deposit_items`, `redemptions`, `point_transactions`, `collection_schedule`) are
left in place and unused, so existing deposit history is not destroyed.

User-posted titles, descriptions and messages are rendered with `textContent`,
never as HTML. Image bytes are never stored in Postgres; only the file storage
URL and id.

## Staging

On `USERNODE_ENV=staging` the app seeds a handful of obviously fake neighbors
(`910001` to `910006`) and items titled "Staging demo: …", including a reserved
item, three completed loops, pending requests and one open report. No seed row is
owned by whoever opens the preview, so My Loops and Impact start at their honest
empty and zero state.

## Development

```sh
npm ci --include=dev
npm start          # serves on PORT, needs DATABASE_URL
npm run build      # compiles styles/tailwind-input.css to public/tailwind.css
```

`npm run build` also runs in every image build (see `Dockerfile`), so the
stylesheet always matches this commit's markup.
