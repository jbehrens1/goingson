# MetroWest Events (and beyond)

A personal event aggregator. Defaults to MetroWest Boston, but the codebase is region-agnostic — point `REGION=palmsprings` (or anything you've configured) and the same app serves a different geography.

**Status: v0 prototype.** Most sources start disabled; flip them on one at a time as you tune them.

## Quick start

```bash
cd ~/Dropbox/goingson
npm install
npm run dev          # http://localhost:3000
```

## Run a real ingest

```bash
# Dry run — fetch & parse, but don't write events.json
npm run ingest:dry

# Pull from all enabled sources, geocode, write public/events.json
npm run ingest

# Test a single source while tuning it
INGEST_ONLY=tcan npm run ingest:dry

# Run for a different region
REGION=palmsprings npm run ingest
```

After `npm run ingest`, the page picks up the new data on the next request (page is `force-dynamic`). The in-app **Refresh data** button does the same thing without leaving the browser.

## What you see in the browser

One chronological list of upcoming events grouped by day, with columns for **time / town · distance / type / event title · venue**. The filter bar lets you:

- **Types** — multi-select pills (live music, comedy, theater, film, art-gallery, museum, lecture, workshop, festival, family, food-drink, fitness, community, sale, other). Inferred from title + description by keyword rules in [`lib/categorize.ts`](./lib/categorize.ts). No selection = all types pass through.
- **Center on** — type any address, city, or ZIP and hit Set. Resolved via Nominatim (OpenStreetMap) with bias toward the region's bounding box (so "Wellesley" doesn't resolve to the UK). Distance to each event is shown next to its town. "No location" shows events whose addresses couldn't be geocoded.
- **Within (mi)** — radius from the center. Only active once a center is resolved.
- **From / To** — date range. From defaults to today; To is open-ended.
- **Refresh data** — runs the ingest server-side via `/api/refresh`. Works while `npm run dev` is running; on Vercel this needs the scheduled GitHub Action instead.

## How regions work

Everything region-specific lives under `config/regions/<region>/`:

```
config/regions/metrowest/
├── region.json     # displayName, defaultCenter, timeZone, locale, boundingBox
├── sources.json    # list of event sources
└── towns.json      # optional list of {name, lat, lon, aliases?} for that region
```

A `REGION=<id>` environment variable selects which directory to use. Defaults to `metrowest`.

To add a new region, e.g. **Palm Springs**:

```bash
mkdir -p config/regions/palmsprings
# Copy metrowest's region.json as a template, then edit:
#   id, displayName, defaultCenter, timeZone, locale, boundingBox, centerSuggestions
# Start with sources.json containing one or two sources you want to try.
# towns.json is optional; useful when many of your event sources don't provide
# precise addresses but do tag with a known town/neighborhood.

REGION=palmsprings npm run ingest:dry
REGION=palmsprings npm run dev
```

The "town" extraction step in `buildEvent` will be a no-op if `towns.json` is missing — fine for regions where you have good address data from your sources.

## How geocoding works

Every event passes through a post-ingest geocoder that resolves its address (or, falling back, "venue, town" or just "town") into `location.lat` / `location.lon`. Distance filtering then works against any user-typed center. We use Nominatim (free, attribution required, rate-limited to 1 req/sec):

- Cached on disk at `data/geocode-cache.json` (in-repo so the cache is committed and re-used in CI).
- Region's `boundingBox` biases ambiguous queries (e.g. "Acton" resolves to Acton, MA, not Acton, UK).
- Negative results (no match) are also cached so we don't hammer Nominatim with known-bad addresses.

If you outgrow Nominatim's rate limit (~3500 requests/day), swap `lib/geocode.ts` for a paid provider (Mapbox, Google) — the cache file makes the switch cheap.

## Adapters

| Adapter | Best for | Notes |
|---|---|---|
| `ical` | The Events Calendar / GrowthZone iCal feeds | Try `<page>?ical=1` or `<page>.ics` first |
| `rss` | Blog/news RSS | Limited use for real events |
| `eventbrite` | Eventbrite per-organizer | Needs `EVENTBRITE_TOKEN` + organizer ID |
| `patch` | patch.com town/region calendars | Reads `__NEXT_DATA__` JSON |
| `wordpress-tribe` | Any WP site running The Events Calendar plugin | Uses `/wp-json/tribe/events/v1/events` |
| `wordpress-mc` | Any WP site running My Calendar plugin (TCAN) | Uses `/wp-json/wp/v2/mc_event` + parses ACF date fields |
| `html-generic` | Anything else | Tries JSON-LD first, falls back to CSS selectors |

## Tuning a new source

1. Open the region's `sources.json` and pick a source.
2. Run `INGEST_ONLY=<id> npm run ingest:dry` and read the warnings.
3. **Check the site's platform first.** If it runs WordPress + The Events Calendar → use `wordpress-tribe`. If WP + My Calendar → use `wordpress-mc`. Iframe or no JS hydration → `html-generic`.
4. **Try iCal next.** Many WordPress + Events Calendar sites expose a feed at `/events/?ical=1` — flip the `adapter` to `ical` and update the `url`.
5. **Otherwise add selectors.** For `html-generic`, view the source's HTML and add to the source's `config`:
   ```json
   "config": {
     "selectors": {
       "item": "article.event",
       "title": ".event-title",
       "link": "a",
       "start": "time",
       "startAttr": "datetime"
     }
   }
   ```

## Project layout

```
.
├── app/
│   ├── page.tsx              Reads region's events.json, hands to <EventsView>
│   ├── EventsView.tsx        Client component: filters, refresh, distance
│   ├── globals.css
│   └── api/
│       ├── refresh/route.ts  POST → run ingest, return new payload
│       └── geocode/route.ts  GET ?q=... → {lat, lon, displayName}
├── lib/
│   ├── adapters/             One per source-type (ical, rss, wordpress-tribe, …)
│   ├── ingest.ts             Orchestrator: load sources, run adapters, geocode, write
│   ├── geocode.ts            Nominatim + on-disk cache + rate limit
│   ├── region.ts             REGION env var → region.json + towns.json loader
│   ├── towns.ts              Pure helpers (haversine, town-name index)
│   ├── categorize.ts         Type-inference keyword rules
│   ├── types.ts
│   └── util.ts               buildEvent, makeEventId, politeFetch
├── config/regions/
│   └── metrowest/
│       ├── region.json
│       ├── sources.json
│       └── towns.json
├── data/
│   └── geocode-cache.json    Persistent geocode results (commit this)
├── public/
│   ├── events.json           Active region's output (page reads this)
│   └── events.<region>.json  Per-region snapshots
├── scripts/ingest.ts         CLI entry (DRY_RUN, INGEST_ONLY, REGION)
└── .github/workflows/
    └── ingest.yml            Daily cron (runs once project is on GitHub)
```

## Deploying to Vercel (free)

After a one-time setup, every commit auto-deploys and the events refresh once a day in the morning via GitHub Actions.

### One-time setup

1. **GitHub account + Git CLI**:
   - Create an account at https://github.com if you don't have one.
   - Install GitHub CLI: `brew install gh`.
   - Authenticate: `gh auth login` (follow the prompts).

2. **Initialize the repo and push**:
   ```bash
   cd ~/Dropbox/goingson
   git init -b main
   git add .
   git commit -m "Initial commit"
   gh repo create goingson --private --source=. --remote=origin --push
   ```

3. **Deploy to Vercel**:
   - Sign up at https://vercel.com using "Continue with GitHub".
   - Click "Add New… → Project", pick the `goingson` repo, accept defaults, click Deploy.
   - First deploy takes ~1 min. You'll get a URL like `goingson.vercel.app`.

4. **Seed `events.json` in the repo**: GitHub → repo → Actions → "Daily ingest" → "Run workflow". This commits a fresh `public/events.json` and triggers a Vercel rebuild.

### Production behavior

The deployed app is read-only at runtime — Vercel/Cloudflare filesystems are ephemeral, so adapters can't write back:

- **`/api/refresh` returns 503** in production. The "Refresh data" button is hidden via a server-side `canRefresh` prop (detects `VERCEL=1` / `CF_PAGES=1` / `READONLY=1`).
- **`/api/geocode`** still works — Nominatim is hit live; cache writes silently no-op. New cache entries land in git only during the GitHub Actions ingest.
- **Page reads** use `force-dynamic` → every request reads the latest `public/events.json` from the deployment bundle. New events appear after the daily commit + auto-rebuild.

### Costs

- **Vercel Hobby**: $0. Fine for personal/free use.
- **Vercel Pro** ($20/mo): required if you ever charge users (Hobby ToS prohibits commercial use).
- **Cloudflare Pages**: free alternative that allows commercial use.
- **GitHub Actions**: free at this volume.
- **Domain** (optional): ~$12/year via Cloudflare or Namecheap.

## Eventbrite

Public Search has been restricted since ~2020. The adapter only supports the per-organizer endpoint. To use it:

1. Create a private token at https://www.eventbrite.com/platform/api/.
2. Find the organizer ID for the venue you care about.
3. In the region's `sources.json`, set `enabled: true` and add `"config": { "organizerId": "12345..." }`.
4. Add a `.env.local` with `EVENTBRITE_TOKEN=...` locally (don't commit it).
5. In **GitHub** → repo Settings → Secrets and variables → Actions, add `EVENTBRITE_TOKEN` so the daily ingest can authenticate too.

## Dropbox sync note

If `node_modules/` or `data/`'s cache file syncs through Dropbox it will be slow. Mark them ignored after first install:

```bash
xattr -w com.dropbox.ignored 1 ~/Dropbox/goingson/node_modules
xattr -w com.dropbox.ignored 1 ~/Dropbox/goingson/.next
```
